import * as fs from 'fs/promises';
import * as path from 'path';
import { OpenAPIParser } from './parseOpenApiSpec';

async function ensureDirectoryExists(filePath: string) {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
}

async function clearDirectory(directory: string) {
    try {
        await fs.rm(directory, { recursive: true, force: true });
        await fs.mkdir(directory, { recursive: true });
        console.log(`Cleared directory: ${directory}`);
    } catch (error) {
        console.error(`Error clearing directory: ${directory}`, error);
    }
}

async function generateGraphQLFromOpenAPI(openApiFilePath: string) {
    try {
        const outputDirectory = './generated';
        await clearDirectory(outputDirectory);

        const parsedPath = path.parse(openApiFilePath);
        const schemaName = parsedPath.name;
        const openApiContent = await fs.readFile(openApiFilePath, 'utf-8');
        const openApiSpec = JSON.parse(openApiContent);
        const parser = new OpenAPIParser(openApiSpec);
        
        // Generate GraphQL schema
        const outputGraphQLFilePath = `${outputDirectory}/${schemaName}.graphql`;
        const graphqlSchema = parser.generateGraphQLSchema();
        await ensureDirectoryExists(outputGraphQLFilePath);
        await fs.writeFile(outputGraphQLFilePath, graphqlSchema);
        
        // Generate DataSource
        const dataSource = parser.generateDataSource();
        const dataSourcePath = `${outputDirectory}/${schemaName}.ts`;
        await ensureDirectoryExists(dataSourcePath);
        await fs.writeFile(dataSourcePath, dataSource);
        console.log(`GraphQL schema generated successfully at ${outputGraphQLFilePath}`);
    } catch (error) {
        console.error("Error generating GraphQL schema:", error);
    }
}

const args = process.argv.slice(2);

if (args.length < 2) {
    console.error('Usage: npm run generate:schema <openApiFile>');
    console.error('Example: npm run generate:schema ./example_open_api/mpo_api_openapi.json');
    process.exit(1);
}

const [openApiFilePath] = args;
generateGraphQLFromOpenAPI(openApiFilePath);