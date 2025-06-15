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

  generateGraphQLSchema(apiName: string): string {
    let schema = '';
    const namespace = pascalCase(apiName);
    // Generate types from components.schemas
    for (const [typeName, schemaObj] of Object.entries(this.spec.components.schemas)) {
      schema += this.generateGraphQLType(namespace, typeName, schemaObj);
    }

    // Generate Query type from paths
    schema += this.generateQueryType(namespace);

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

  private generateQueryType(namespace: string): string {
    let query = 'type Query {\n';
    
    for (const [path, pathItem] of Object.entries(this.spec.paths)) {
      if (pathItem.get) {
        const operation = pathItem.get;
        const returnType = this.getReturnType(namespace, operation);
        const params = this.getParameters(namespace, operation);
        
        query += `  ${operation.operationId}${params}: ${returnType}\n`;
      }
    }
    
    query += '}\n';
    return query;
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
}