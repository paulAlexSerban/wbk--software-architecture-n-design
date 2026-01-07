# Mascar.auto - The Real Autonomous Car
> FROM: "Software Architecture Case Studies" on Udemy

## Overview
- manufactures autonomous systems for vehicles
- it can take a completely normal car and add autonomous driving capabilities to it via a software and hardware kit
- autonomous car is the holy grail of the automotive industry, the first company to achieve it will reap huge rewards
- has more than 10000 vechicles on the road currently using its autonomous driving system
- expects more than 200000 vehicles to be using its system by the end of the year
- needs to build a new computer system to reliably receive telemetry from cars and display data about them

## Important Aspects

## Requirements

### Functional Requirements (What the system should do)
- Web based
- Receive telemetry from cars (location, speed, breakdowns, etc.)
- Store telemetry in a persistent store
- Display dashboards summarizing the data
- Perform analysis on the data

### Non-Functional Requirements (What the system should deal with)
What we know:
- Data intensive system
- Not a lot of users (hundreds)
- A lot of data
- Performance is important

What to ask?
- How many expected concurrent users? (will help size the web and application servers) ~ 10 users
- How many telemetry messages received per second? (will help determine the load applied on the system) ~ 7000 messages/second
- What is the average size of each message?(will help determine the storage and bandwidth requirements) ~ 1 KB (1024 bytes)
- Is the message schema-less? (will help determine the type of database to use) - Yes, messages can have different fields
- Can we tollerate some message loss? (will help determine the messaging system to use) - Yes (soft of...), some message loss is acceptable
- What is the desired SLA? (will help determine the architecture and technologies to use) - Highest possible (not a number, but very high)

Data volume estimation:
- 1 message = 1 KB
- 7000 messages/second = 7 MB/second
  - 7 MB/second * 60 seconds = 420 MB/minute
  - 420 MB/minute * 60 minutes = 25.2 GB/hour
  - 25.2 GB/hour * 24 hours = 604.8 GB/day
  - 604.8 GB/day * 30 days = 18.144 TB/month
  - 18.144 TB/month * 12 months = 217.728 TB/year <-- almost 0.25 PB/year (which is a lot of data - no normal RDBMS can handle this amount of data without special techniques)

Retention period:
- How long do we need to keep the data? (will help determine the storage requirements)
- What happens to old data? (will help determine the data management strategy)
  - Delete
  - Move to an archive datastore
- Motivation for retention period:
  - Keeps the database from growing indefinitely and exceeding storage capacity
  - Improves query performance by reducing the amount of data to scan
  - Complies with data governance and regulatory requirements
- Conclusion:
  - Muscar needs two types of data:
    - Operational, near real-time data (location, speed, etc.) - kept for 7 days
    - Aggregated and ready for analysis data(BI reports, ML models, etc.) - kept for several years

| Data Type        | used for...                      | Retention Period | Storage Type       |
| ---------------- | -------------------------------- | ---------------- | ------------------ |
| Operational Data | Monitor real time data from cars | 7 days           | Hot Storage (SSD)  |
|                  | Performance is crytical          |                  |                    |
| Aggregated Data  | Analysis, BI, ML models          | Several years    | Cold Storage (HDD) |
|                  | Not real time, can be slower     |                  |                    |

Data vlolume estimation (after retention period):
- Operational Data:
  - 7 days * 604.8 GB/day = 4.2336 TB
- Aggregated Data:
  - Assume we keep 3 years of data
  - 3 years * 217.728 TB/year = 653.184 TB
  - Total: ~ 657.4176 TB

Summary:
- 10 concurrent users
- 7000 messages/second
- Max data in Operational Store: ~ 4.5 TB
- Max data in Aggregated Store: ~ 650 TB
- The application is mission critical, high availability and performance are a must
- Performance is crytical for operational data, less so for aggregated data

## Executive Summary

## Components
Based on [the requirements](#requirements), the following components can be identified in the system:
- Cars (clients) - represent the thousands of autonomous vehicles on the road sending telemetry data to the system
  - not part of the system, as we do not habve any control, but important to understand the data flow
- Telemetry Gateway 
  - responsible for receiving telemetry data from cars
  - should be highly available and scalable to handle the load
  - should provide some level of message durability to avoid data loss
  - no business logic (no validation), just a pass-through component
- Telemetry Pipeline
  - responsibe for queueing the telemetry messages for processing
  - receives messages and puts them in the pipeline
  - the other components will poll messages from the pipeline for processing
- Telemetry Processor
  - responsible for validation of the messages and processing
  - will poll messages from the pipeline, validate them, do the actual processing, and store them in the appropriate data store
- Operational Data Store
  - responsible for storing the operational telemetry data
  - should be optimized for fast writes and reads
  - should be able to handle the expected data volume
- Data Warehouse
  - responsible for storing the aggregated telemetry data for analysis
  - should be optimized for analytical queries
  - should be able to handle the expected data volume
- Telemetry Viewer
  - queries the database and displays real-time data to users
  - should be web-based and user-friendly
- BI and Analytics Application
  - responsible for performing analysis on the aggregated data
  - should provide tools for generating reports and visualizations
  - should be able to handle complex queries on large datasets
  - not connected to the operational data store to avoid performance impact
  - works only on the data warehouse
- Archive Database
  - responsible for storing older telemetry data that is no longer needed for real-time analysis but must be retained for compliance or historical purposes
  - should be able to handle large volumes of data at a lower cost
  - performance is less critical compared to operational and aggregated data stores

### Messaging System
- The messaging system is a critical component of the architecture, responsible for decoupling the telemetry
- The **Cars** send telemetry data to the **Telemetry Gateway**, via TCP protocol
- The **Operational Data Store** archives data in the **Archive Database**, via ETL (Extract, Transform, Load) processes
- The communication protocol from **Telementry Gateway** to **Telemetry Pipeline** and from **Telemetry Pipeline** to **Telemetry Processor** are going to be dictated by the technology used in the pipeline (e.g., Kafka, RabbitMQ, etc.)

## Services Drill Down

### Telemetry Gateway
What it does:
- Receives telemetry data from cats using TCP protocol
- Pushes the telemetry data to the pipeline component
Application Type: Service
Technology Stack:
- Considerations:
  - Load: must handle 7000 messages/second
  - Performance (critical): must be low latency
  - Team expertise: what does the team know?
    - Programming Language: Devs are currently using Python and JavaScript
    - Python can't be used for the gateway due to performance requirements (Python is slow)
    - We look for a language with great performance. runs on Linux, and leverages the current skills (JavaScript and Python)
    - Node.js is a good fit (JavaScript runtime, great performance, runs on Linux)
  - Environment(OS, Cloud provider, etc.)
    - OS: Use only Linux based systems
Architecture:
- Sevice Interface - grabs the messages and pushes to the pipeline
Redundancy:
- Deploy multiple instances behind a load balancer
- Use auto-scaling to handle load spikes
- Use health checks to monitor instance health

### Telemetry Pipeline
What it does:
- Gets the telemetry messages from the gateway
- Queues the telemetry for futher processing
- Basically - a queue for streaming high volume data

Questions:
- Is there an existing queue mechanism in the company? - NO
- Develop our own or use a third party solution?
  - Best practice: use a third party solution unless there is a very good reason not to
  - Solution: Apache Kafka - A Distributed Streaming Platform

Comparison of Queue Systems:
| Queue System | Pros                               | Cons                     |
| ------------ | ---------------------------------- | ------------------------ |
| RabbitMQ     | Easy to set up and use             | Not as scalable as Kafka |
|              | Good for simple use cases          | Lower throughput         |
|              | Mature and stable                  |                          |
| Apache Kafka | High throughput, scalable, durable | Complex setup            |
|              | Very popular in the industry       | Complex configuration    |
|              | High availability support          |                          |

### Telemetry Processor
What it does:
- polls the messages from the pipeline
- processes the messages (validation, transformation, etc.)
- stores the messages in the appropriate data store (operational or archive)
Application Type: Service 
- the component will communicate with the **Telemetry Pipeline** to get the messages and needs to be always on

Technology Stack:
- For:
  - Processor - the developmnt platform of the processors
  - Datastore - the database where the processed data will be stored
- Processor: NodeJS (same as gateway, team expertise, performance, great Kafka support)
- Datastore - Operational Data Store: NoSQL Database (schema-less messages, high performance for reads and writes)
  - What we look for:
    - Schema-less message support
    - Quick retrival capabilities
    - No complex queries (only by device ID and time range)
  - Solution: NoSQL Database - MongoDB
    - Schema-less
    - Great performance for reads and writes
    - Scalable
    - Good support for time-series data
    - Team expertise with NoSQL databases
- Datastore - Archive Data Store: Data Lake (cheap storage for large volumes of data)
  - What we look for:
    - Support for large volumes of data (~225 TB)
    - Not accessed frequently
    - No need for fast retrival
    - Save costs
  - Alternatives:
    - Cold HDD Storage
    - Cloud Storage (AWS S3, Azure Blob Storage, Google Cloud Storage)
  - Solution: Cloud Storage - Microsoft Azure Blob Storage
    - Meets all requirements
    - Virtually unlimited storage
    - Cheap storage
    - Good integration with other Azure services
Architecture:
- Staring from the classic 3-tier architecture:
  - Service Interface - polls messages from the pipeline
  - Business Logic - processes the messages
  - Data Access Layer - stores the messages in the appropriate data store
  - Data Stores - Operational Data Store (MongoDB) and Archive Data Store (Azure Blob Storage)
Redundancy:
- Deploy multiple instances behind a load balancer
- Use auto-scaling to handle load spikes
- Use health checks to monitor instance health

### Telemetry Viewer
What it does:
- Allows end users to query telemetry data
- Displays real time data
What it does not do:
- Analyze data
- Store data

Application Type: Web Application (web server, web api, frontend)
Technology Stack:
  - Backend: NodeJS (team expertise, performance, great MongoDB support)
  - Frontend: React (team expertise, great for building user interfaces)
Architecture:
- 3-tier architecture:
  - Service Interface - handles user requests
  - Business Logic - processes user requests
  - Data Access Layer - queries the operational data store
  - Data Store - Operational Data Store (MongoDB)

API:
- get latest errors for all cars
- get latest telemetry for specific cat
- get latest errors for specific car

API Design:
| Functionality                         | Path/Endpoint                    | Method | Description                    | Parameters   | Return Codes |
| ------------------------------------- | -------------------------------- | ------ | ------------------------------ | ------------ | ------------ |
| Get Latest Errors for All Cars        | /api/v1/telemetry/errors         | GET    | Get latest errors for all cars | None         | 200, 500     |
| Get Latest Telemetry for specific car | /api/v1/telemetry/{carId}        | GET    | Get latest telemetry for a car | carId (path) | 200, 404,500 |
| Get Latest Errors for specific car    | /api/v1/telemetry/errors/{carId} | GET    | Get latest errors for a car    | carId (path) | 200, 404,500 |

Redundancy:
- Deploy multiple instances behind a load balancer
- Use auto-scaling to handle load spikes
- Use health checks to monitor instance health

### BI Application & Data Warehouse
What it does:
- Analyzes telemetry data
- Displays reports about the datam trends, forecasts, etc.
  - Eg. How many cars did break during the last month?
  - Eg. What is the total distance driven by all cars during the last year?

What it does not do:
- Display real time data
- Store operational data

Application Type: Does not matter, because the BI Application is always based on third party tools (Power BI, Tableau, etc.)
  - BI Applications are always based on existing tools, we do not build our own BI Application from scratch
  - How to choose the BI tool?
    - Market research (Gartner, Forrester, etc.)
    - Team expertise
    - Cost
    - Features
    - Integration with Data Warehouse
  - An important lesson:
    - Designing the BI solution is NOT part of the architect's job
    - Always use BI experts for this task
    - The specifics of the BI solution must be designed together with the BI team