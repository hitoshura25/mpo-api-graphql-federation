# mpo-api-graphql-federation
Exploring GraphQL Schema and code generation for mpo-api datasources

***Disclaimer***: Used various AI tools to learn how to set this up from within VS Code (Amazon Q, Gemini 2.0 Flash, GPT-4o, Claude 3.5 Sonnet) 

# Next steps
1. Create Apollo compliant GraphQL specs that can connect the GraphQL scheme back to the api definition
2. Try and utilize the Apollo code generation tools for each client (Android, Typescript, web,swift) to see if we can generate all the code to query the data
3. Deploy each client code into its own library (and setup up testing to ensure they work)
4. See if a Federated Graph built from the individual graphs will also generate the code to fetch those queries