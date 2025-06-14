import type { CodegenConfig } from '@graphql-codegen/cli'
 
const config: CodegenConfig = {
  schema: '../../schemas',
  documents: ['src/**/*.ts'],
  ignoreNoDocuments: true,
  generates: {
    './generated/src/graphql/': {
      preset: 'client',
      config: {
        documentMode: 'string'
      }
    },
    './generated/schema.graphql': {
      plugins: ['schema-ast'],
      config: {
        includeDirectives: true
      }
    }
  }
}
 
export default config