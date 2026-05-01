# NoSQL Database

## Why NoSQL?

Relational Databases:

- not suited for unstructured data
- not suited for Big Data applications (Big Data means huge volume, high velocity, and extensible variety of data)

## Basics of NoSQL Databases

- Not Only SQL
- Non-relational in nature
- Support for unstructured data
- Well suited for Big Data applications

> Big Data
>
> - Volume: Terabytes to Petabytes
> - Velocity: Real-time or near real-time
> - Variety: Structured, unstructured, semi-structured

## ACID Behavior

> these properties define how relational databases ensure data integrity

- Atomicity - a transaction is all or nothing - can execute multiple operations as a single unit
- Consistency - a transaction must bring the database from one valid state to another
- Isolation - multiple transactions can occur concurrently without affecting each other
- Durability - once a transaction is committed, it will remain committed even in the case of a system failure

### SQL
- enforce strict ACID properties
- loss of flexibility

### NoSQL
- trades some ACID properties for performance and scalability
- flexible data model

## Scaling
### SQL
- vertical scaling
- you scale up by adding more resources to a single server (CPU, RAM, etc)

### NoSQL
- horizontal scaling
- you scale out by adding more servers to your pool of resources

## Interaction APIs
- SQL - uses SQL (Structured Query Language) for interacting with the database
- NoSQL - uses Object-based APIs (Application Programming Interfaces) for interacting with the database

## Types of NoSQL Databases
1. Columnar Databases
    - store data in columns rather than rows
    - well suited for analytical queries
    - eg. Apache Cassandra, HBase
2. Document Databases
   - store data in documents (JSON, XML, etc)
   - well suited for content management systems
   - eg. MongoDB, CouchDB
3. Key-Value Stores
   - store data in key-value pairs
   - well suited for caching and session management
   - eg. Redis, DynamoDB
4. Graph Databases
   - store data in nodes and edges
   - well suited for social networks and recommendation engines
   - eg. Neo4j, Amazon Neptune
5. Time Series Databases
   - store data in time-ordered sequences
   - well suited for IoT applications
   - eg. InfluxDB, TimescaleDB
6. Object-Oriented Databases
   - store data as objects
   - well suited for object-oriented programming languages
   - eg. db4o, ObjectDB
7. XML Databases
   - store data in XML format
   - well suited for XML-based applications
   - eg. BaseX, eXist-db
8. Multimodel Databases
   - support multiple data models
   - well suited for applications with diverse data requirements
   - eg. ArangoDB, OrientDB
9. NewSQL Databases
   - combine the scalability of NoSQL with the ACID properties of SQL
   - eg. Google Spanner, CockroachDB
   - well suited for distributed applications