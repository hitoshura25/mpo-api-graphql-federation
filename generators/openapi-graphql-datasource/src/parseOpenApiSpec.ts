import { pascalCase } from 'change-case';
import * as fs from 'fs';

export interface OpenAPISpec {
  openapi: string;
  paths: {
    [path: string]: PathItem;
  };
  components: {
    schemas: {
      [name: string]: SchemaObject;
    };
  };
  info: {
    title: string;
    version: string;
  };
}

export interface PathItem {
  get?: Operation;
  post?: Operation;
  put?: Operation;
  delete?: Operation;
}

export interface Operation {
  operationId: string;
  summary?: string;
  parameters?: Parameter[];
  responses: {
    [code: string]: Response;
  };
}

export interface Parameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema: SchemaObject;
}

export interface Response {
  description: string;
  content?: {
    [mediaType: string]: {
      schema: SchemaObject;
    };
  };
}

export interface SchemaObject {
  type?: string;
  properties?: {
    [name: string]: SchemaObject;
  };
  items?: SchemaObject;
  required?: string[];
  $ref?: string;
  anyOf?: SchemaObject[];
  format?: string;
}

export class OpenAPIParser {
  constructor(private spec: OpenAPISpec) {}

  private schemasPresentInQueries: { [name: string]: boolean } = {};

  generateGraphQLSchema(apiName: string, baseURL: string): string {
    const namespace = pascalCase(apiName);

    // Add federation directives and schema extensions
    let schema = `extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.11", import: ["@key"])
  @link(
    url: "https://specs.apollo.dev/connect/v0.2"
    import: ["@source", "@connect"]
  )
  @source(
    name: "${apiName}"
    http: { baseURL: "${baseURL}" }
  )

`;

    const componentSchemas = Object.entries(this.spec.components.schemas)

    // Generate Query type from paths
    schema += this.generateQueryType(namespace, apiName, componentSchemas);

    // Generate types from components.schemas
    for (const [typeName, schemaObj] of componentSchemas) {
        if (!this.schemasPresentInQueries[typeName]) continue
        schema += this.generateGraphQLType(namespace, typeName, schemaObj);
    }

    return schema;
  }

  generateDataSource(apiName: string, baseUrl: string): string {
    let source = `
import { RESTDataSource } from '@apollo/datasource-rest';

export class ${pascalCase(apiName)}DataSource extends RESTDataSource {
  override baseURL = '${baseUrl}';

`;

    // Generate methods for each path
    for (const [path, pathItem] of Object.entries(this.spec.paths)) {
      if (pathItem.get) {
        source += this.generateDataSourceMethod(path, 'get', pathItem.get);
      }
      // Add other HTTP methods as needed
    }

    source += '}\n';
    return source;
  }

  private generateGraphQLType(namespace: string, name: string, schema: SchemaObject): string {
    if (!schema.properties) return '';

    let type = `type ${namespace}${name} {\n`;
    
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      const isRequired = schema.required?.includes(propName);
      type += `  ${propName}: ${this.getGraphQLType(namespace, propSchema)}${isRequired ? '!' : ''}\n`;
    }
    
    type += '}\n\n';
    return type;
  }

  private getGraphQLType(namespace: string, schema: SchemaObject): string {
    if (schema.$ref) {
      return `${namespace}${schema.$ref.split('/').pop()}` || 'String';
    }

    if (schema.type === 'array') {
      return `[${this.getGraphQLType(namespace, schema.items!)}]`;
    }

    if (schema.anyOf) {
      return schema.anyOf.filter((s) => s.type !== 'null' ).map((s) => this.getGraphQLType(namespace, s)).join(' | ');
    }

    switch (schema.type) {
      case 'integer':
        return 'Int';
      case 'number':
        return 'Float';
      case 'boolean':
        return 'Boolean';
      default:
        return 'String';
    }
  }

  private generateQueryType(namespace: string, sourceName: string, componentSchemas: [string, SchemaObject][]): string {
    let query = 'type Query {\n';
    
    for (const [path, pathItem] of Object.entries(this.spec.paths)) {
      if (pathItem.get) {
        const operation = pathItem.get;
        const selection = this.generateSelectionSet(operation, componentSchemas);
        if (!selection) {
            console.warn(`Skipping operation ${operation.operationId} due to no selection.`);
            continue
        }

        const returnType = this.getReturnType(namespace, operation);
        const params = this.getParameters(namespace, operation);
        const connectParams = this.getConnectParams(operation);

        query += `  ${operation.operationId}${params}: ${returnType}
    @connect(
      source: "${sourceName}"
      http: { GET: "${path}${connectParams ? `?${connectParams}` : ''}" }  
      selection: ${selection}
    )\n`;      
      }
    }
    
    query += '}\n';
    return query;
  }

  private getResponseOrOverride(operation: Operation, responseCode: string): Response {
    const response = operation.responses[responseCode];
    const responseFile = `./schema_override_responses/${operation.operationId}_${responseCode}.json`;

    if (fs.existsSync(responseFile)) {
      try {
        const responseContent = fs.readFileSync(responseFile, 'utf-8');
        const responseJson = JSON.parse(responseContent);

        // Infer schema from JSON response
        const schema = this.inferSchema(responseJson);

        return {
          description: `Response from ${responseFile}`,
          content: {
            'application/json': {
              schema: schema,
            },
          },
        };
      } catch (error) {
        console.error(`Error reading or parsing response file ${responseFile}:`, error);
        return response
      }
    }

    return response
  }

  private generateSelectionSet(operation: Operation, componentSchemas: [string, SchemaObject][]): string {
    let allFields: string[] = [];
    const indentation = '      '; // 6 spaces for GraphQL selection set indentation
    for (const responseCode in operation.responses) {
     if (responseCode !== '200') {
        continue; // Errors should not be included in the selection set
     }
      const response = this.getResponseOrOverride(operation, responseCode);
      if (response?.content?.['application/json']?.schema) {
        const schema = response.content['application/json'].schema as SchemaObject;
        const fields = this.extractFields(schema, componentSchemas, indentation);
        allFields = allFields.concat(fields);
      }
    }

    if (allFields.length === 0) {
      allFields = [`${indentation}id`];
    }

    const selectionSet = [...new Set(allFields)].join(`\n`)
    return `"""\n${selectionSet}\n${indentation}"""`;
  }

  private extractFields(schema: SchemaObject, componentSchemas: [string, SchemaObject][], indentation: string): string[] {
    const fields: string[] = [];
    let currentSchema = schema;
    if (schema.$ref) {
      const refName = schema.$ref.split('/').pop();
      const componentSchema = componentSchemas.find(([name]) => name === refName);
      if (componentSchema && componentSchema[1]) {
        currentSchema = componentSchema[1];
        this.schemasPresentInQueries[componentSchema[0]] = true;
      }
    }

    if (currentSchema.properties) {
      for (const [fieldName, fieldSchema] of Object.entries(currentSchema.properties)) { 
        // Handle nested objects
        if (fieldSchema.type === 'object' && fieldSchema.properties) {
          const nestedFields = this.extractFields(fieldSchema, componentSchemas, indentation);
          const nestedFieldsSelect = nestedFields.length > 0 ? nestedFields.join(`\n`) : ''
          fields.push(`${indentation}${fieldName} {\n${nestedFieldsSelect}\n}`);
        } else if (fieldSchema.type === 'array' && fieldSchema.items) {
          const arrayItemFields = this.extractFields(fieldSchema.items, componentSchemas, `${indentation}  `);
          const arrayItemFieldsSelect = arrayItemFields.length > 0 ? arrayItemFields.join(`\n`) : ''
          fields.push(`${indentation}${fieldName} {\n${arrayItemFieldsSelect}\n${indentation}}`);
        } else if (fieldSchema.$ref) {
            const refName = fieldSchema.$ref.split('/').pop();
            const componentSchema = componentSchemas.find(([name]) => name === refName);
            if (componentSchema && componentSchema[1]) {
                const refItemFields = this.extractFields(componentSchema[1], componentSchemas, `${indentation}  `);
                const refItemFieldsSelect = refItemFields.length > 0 ? refItemFields.join(`\n`) : ''
                fields.push(`${indentation}${fieldName} {\n${refItemFieldsSelect}\n${indentation}}`);
                this.schemasPresentInQueries[componentSchema[0]] = true;
            }
        } else {
          fields.push(`${indentation}${fieldName}`);
        }
      }
    }

    return fields;
  }

  private generateDataSourceMethod(path: string, method: string, operation: any): string {
    const params = operation.parameters?.map((p: any) => 
      `${p.name}: ${this.getTypeScriptType(p.schema)}`
    ).join(', ') || '';

    const queryParams = operation.parameters?.filter((p: any) => p.in === 'query')
      .map((p: any) => `${p.name}: ${p.name}`).join(',\n        ');

    return `
  async ${operation.operationId}(${params}) {
    return this.${method}(\`${path}\`${
      queryParams ? `,
      {
        params: {
          ${queryParams}
        }
      }` : ''
    });
  }
`;
  }

  private getTypeScriptType(schema: SchemaObject): string {
    if (schema.type === 'array') {
      return `${this.getTypeScriptType(schema.items!)}[]`;
    }

    switch (schema.type) {
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      default:
        return 'string';
    }
  }

  private getReturnType(namespace: string, operation: any): string {
    const successResponse = this.getResponseOrOverride(operation, '200');
    if (!successResponse?.content) return 'Boolean';

    const schema = successResponse.content['application/json'].schema;
    return this.getGraphQLType(namespace, schema);
  }

  private getParameters(namespace: string, operation: any): string {
    if (!operation.parameters?.length) return '';

    const params = operation.parameters.map((p: any) => 
      `${p.name}: ${this.getGraphQLType(namespace, p.schema)}`
    ).join(', ');

    return `(${params})`;
  }

  private getConnectParams(operation: any): string {
    if (!operation.parameters?.length) return '';

    const params = operation.parameters.map((p: any) =>
      `${p.name}=\{$args.${p.name}\}` // Use $args to reference GraphQL arguments
    ).join('&');

    return params;
  }

  private createOpenAPISchemaFromJSON(json: any, title: string): OpenAPISpec {
        const schema = this.inferSchema(json);

        const openAPISpec: OpenAPISpec = {
            openapi: "3.0.0",
            info: {
                title: title,
                version: "1.0.0",
            },
            paths: {},
            components: {
                schemas: {
                    [title]: schema,
                },
            },
        };

        return openAPISpec;
    }

    private inferSchema(json: any): SchemaObject {
        if (typeof json === "string") {
            return { type: "string" };
        } else if (typeof json === "number") {
            if (Number.isInteger(json)) {
                return { type: "integer", format: "int32" };
            } else {
                return { type: "number", format: "float" };
            }
        } else if (typeof json === "boolean") {
            return { type: "boolean" };
        } else if (Array.isArray(json)) {
            if (json.length > 0) {
                const itemSchema = this.inferSchema(json[0]);
                return { type: "array", items: itemSchema };
            } else {
                return { type: "array", items: {} }; // Empty array
            }
        } else if (typeof json === "object" && json !== null) {
            const properties: { [name: string]: SchemaObject } = {};
            for (const key in json) {
                if (json.hasOwnProperty(key)) {
                    properties[key] = this.inferSchema(json[key]);
                }
            }
            return { type: "object", properties: properties };
        } else {
            return { type: "string" }; // Default
        }
    }
}