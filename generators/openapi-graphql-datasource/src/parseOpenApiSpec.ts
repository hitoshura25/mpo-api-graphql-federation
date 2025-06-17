import { pascalCase } from 'change-case';

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
}

export class OpenAPIParser {
  constructor(private spec: OpenAPISpec) {}

  private schemasPresentInQueries: { [name: string]: Boolean } = {};

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

        query += `  ${operation.operationId}${params}: ${returnType}
    @connect(
      source: "${sourceName}"
      http: { GET: "${path}?${this.getConnectParams(operation)}" }  
      selection: """
      ${selection}
      """
    )\n`;      
      }
    }
    
    query += '}\n';
    return query;
  }

  private generateSelectionSet(operation: Operation, componentSchemas: [string, SchemaObject][]): string {
    let allFields: string[] = [];

    for (const responseCode in operation.responses) {
     if (responseCode !== '200') {
        continue; // TODO: Figure out errors
     }
      const response = operation.responses[responseCode] as Response;
      if (response?.content?.['application/json']?.schema) {
        const schema = response.content['application/json'].schema as SchemaObject;
        const fields = this.extractFields(schema, componentSchemas);
        allFields = allFields.concat(fields);
      }
    }

    if (allFields.length === 0) {
      return 'id';
    }

    return [...new Set(allFields)].join('\n'); // Deduplicate fields
  }

  private extractFields(schema: SchemaObject, componentSchemas: [string, SchemaObject][]): string[] {
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
          fields.push(fieldName);
          const nestedFields = this.extractFields(fieldSchema, componentSchemas);
          fields.push(...nestedFields.map(f => `${fieldName} { ${f} }`));
        } else if (fieldSchema.type === 'array' && fieldSchema.items) {
          const arrayItemFields = this.extractFields(fieldSchema.items, componentSchemas);
          const arrayItemFieldsSelect = arrayItemFields.length > 0 ? arrayItemFields.join('\n') : ''
          fields.push(`${fieldName} {\n${arrayItemFieldsSelect}\n}`);
        } else if (fieldSchema.$ref) {
            const refName = fieldSchema.$ref.split('/').pop();
            const componentSchema = componentSchemas.find(([name]) => name === refName);
            if (componentSchema && componentSchema[1]) {
                const refItemFields = this.extractFields(componentSchema[1], componentSchemas);
                const refItemFieldsSelect = refItemFields.length > 0 ? refItemFields.join('\n') : ''
                fields.push(`${fieldName} {\n${refItemFieldsSelect}\n}`);
                this.schemasPresentInQueries[componentSchema[0]] = true;
            }
        } else {
          fields.push(fieldName);
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
    const successResponse = operation.responses['200'];
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
      `${p.name}=$${p.name}` // Use $args to reference GraphQL arguments
    ).join('&');

    return params;
  }
}