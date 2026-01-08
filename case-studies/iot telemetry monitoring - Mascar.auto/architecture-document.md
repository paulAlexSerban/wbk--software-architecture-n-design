# Mascar.auto - The Real Autonomous Car
> FROM: "Software Architecture Case Studies" on Udemy

## Overview

Mascar.auto is a pioneering automotive technology company that manufactures autonomous driving systems for vehicles. Their innovative solution transforms ordinary vehicles into autonomous cars through a comprehensive software and hardware retrofit kit, positioning them as a leader in the race toward fully autonomous transportation.

**Business Context:**
- **Industry**: Autonomous Vehicle Technology & Automotive Software
- **Business Model**: B2B - Selling autonomous driving retrofit kits to vehicle manufacturers and fleet operators
- **Market Position**: First-to-market advantage in the autonomous vehicle retrofit space
- **Business Value**: Autonomous driving is the "holy grail" of automotive industry—first successful company will dominate market
- **Current Scale**: 10,000+ vehicles actively using Mascar.auto's autonomous driving system
- **Growth Projection**: Expected to reach 200,000+ vehicles by end of current year (20x growth)

**System Characteristics:**
- **Real-Time Telemetry**: Continuous stream of data from thousands of autonomous vehicles
- **Mission-Critical**: System reliability directly impacts vehicle safety and regulatory compliance
- **High Volume**: Processing ~7,000 messages/second from vehicles (location, speed, diagnostics, breakdowns)
- **Data Intensive**: Near-petabyte scale annual data volume (217 TB/year)
- **Dual Purpose**: 
  - **Operational Monitoring**: Real-time vehicle health and performance dashboards
  - **Analytics & ML**: Historical data analysis for system improvements and predictive maintenance
- **Regulatory Requirements**: Data retention for safety audits and incident investigation

**Scope of This Document:**
This architecture document focuses on the telemetry ingestion, storage, and visualization platform that enables Mascar.auto to:
1. Reliably receive telemetry from autonomous vehicles at scale
2. Store operational data for real-time monitoring (7-day retention)
3. Archive aggregated data for long-term analysis (multi-year retention)
4. Provide real-time dashboards for operations teams
5. Enable business intelligence and machine learning on historical data

## Important Aspects

## Requirements

### Functional Requirements (What the system should do)

- **Telemetry Ingestion**: Receive real-time telemetry messages from autonomous vehicles via TCP protocol
  - Vehicle location (GPS coordinates, altitude)
  - Vehicle speed and acceleration
  - System diagnostics (CPU, memory, sensor health)
  - Breakdown alerts and error codes
  - Environmental data (weather, road conditions)
  - Driver intervention events
  
- **Data Storage**: Persist telemetry in two-tier storage architecture
  - **Operational Store**: Hot storage for recent data (7-day retention)
  - **Archive Store**: Cold storage for historical data (3+ years retention)
  - Support schema-less messages (different vehicle models send different fields)
  
- **Real-Time Monitoring**: Web-based dashboards for operations team
  - Display latest telemetry for specific vehicle
  - Show latest errors across all vehicles
  - Alert on critical system failures or safety events
  - Filter and search by vehicle ID, time range, error type
  
- **Data Analysis**: Enable business intelligence and machine learning
  - Aggregate raw telemetry for trend analysis
  - Generate reports (e.g., total miles driven, breakdown frequency by model)
  - Support predictive maintenance models
  - Export data for ML training pipelines
  
- **Data Lifecycle Management**: Automated data retention and archival
  - Move operational data to archive after 7 days
  - Compress and aggregate data for long-term storage
  - Delete data beyond retention period (compliance with data governance)

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

**Summary of Non-Functional Requirements:**
- **Concurrent Users**: ~10 (operations team monitoring dashboards)
- **Message Throughput**: 7,000 messages/second from vehicles
- **Message Size**: ~1 KB per message (1024 bytes)
- **Data Volume - Operational Store**: ~4.5 TB (7 days retention)
- **Data Volume - Archive Store**: ~650 TB (3 years retention)
- **Total Annual Data Growth**: ~217 TB/year (nearly 0.25 PB)
- **Schema Flexibility**: Messages are schema-less (vary by vehicle model)
- **Message Loss Tolerance**: Some message loss acceptable (< 0.1%)
- **High Availability**: Mission-critical system requiring 99.95%+ uptime
- **Performance Priority**: Real-time ingestion and operational queries critical; analytics queries can tolerate latency
- **Scalability Target**: Support 20x vehicle growth (10K → 200K vehicles) within current year

## Executive Summary

**Architecture Style:** Event-Driven Architecture (EDA) with Lambda Architecture pattern (real-time + batch processing)

**Key Architectural Components:**

1. **Telemetry Gateway** (Node.js Service)
   - High-performance TCP server receiving vehicle telemetry
   - Load-balanced across multiple instances for 7K msg/sec throughput
   - Stateless design enabling horizontal scaling
   - Pushes messages to Telemetry Pipeline with minimal latency

2. **Telemetry Pipeline** (Apache Kafka)
   - Distributed streaming platform providing message durability and buffering
   - Decouples ingestion from processing (backpressure handling)
   - Supports multiple consumer groups (processor, analytics, monitoring)
   - Retains messages for replay and failure recovery

3. **Telemetry Processor** (Node.js Service)
   - Consumes messages from Kafka pipeline
   - Validates and enriches telemetry data
   - Writes to dual storage: Operational Store (hot) and Archive Store (cold)
   - Handles data transformation and aggregation

4. **Operational Data Store** (MongoDB)
   - NoSQL database optimized for high-throughput writes and fast reads
   - Schema-less storage for heterogeneous vehicle messages
   - 7-day rolling retention with TTL (Time To Live) indexes
   - Indexed on vehicle ID and timestamp for fast queries

5. **Archive Data Store** (Azure Blob Storage)
   - Cold storage for aggregated historical data (3+ years)
   - Cost-effective at petabyte scale (~$650 TB)
   - Data compressed and partitioned by date
   - Accessed infrequently for BI and ML workloads

6. **Telemetry Viewer** (Node.js + React Web App)
   - Real-time dashboard for operations team
   - Queries Operational Data Store only (no impact on archive)
   - REST API exposing vehicle telemetry and error endpoints
   - Load-balanced for high availability

7. **BI & Analytics Platform** (Third-Party Tool + Data Warehouse)
   - Separate data warehouse optimized for analytical queries
   - BI tool (e.g., Power BI, Tableau) for reports and visualizations
   - Queries Archive Store, not Operational Store (performance isolation)
   - Supports complex aggregations, trend analysis, ML model training

**Technology Stack:**
- **Application Services**: Node.js (gateway, processor, viewer backend)
- **Frontend**: React (dashboard UI)
- **Message Queue**: Apache Kafka (streaming pipeline)
- **Operational Database**: MongoDB (NoSQL, schema-less)
- **Archive Storage**: Azure Blob Storage (cold storage)
- **Data Warehouse**: Azure Synapse Analytics or Snowflake (BI queries)
- **Orchestration**: Kubernetes (container orchestration)
- **Monitoring**: Prometheus + Grafana (metrics, alerting)

**Key Architectural Principles:**

1. **Separation of Hot and Cold Paths**
   - Hot path: Real-time ingestion → Operational Store → Dashboard (< 1 second latency)
   - Cold path: Batch aggregation → Archive Store → BI/Analytics (minutes to hours latency)
   - Prevents analytics workloads from impacting operational performance

2. **Decoupling via Messaging**
   - Kafka decouples producers (gateway) from consumers (processor)
   - Enables independent scaling and deployment
   - Provides buffering during traffic spikes or downstream failures

3. **Horizontal Scalability**
   - All services stateless and containerized (Kubernetes)
   - Gateway, processor, viewer scale independently based on load
   - MongoDB sharding for operational data growth
   - Kafka partitioning for parallel message processing

4. **Cost Optimization via Tiered Storage**
   - Operational data on expensive SSD (fast, 7-day retention)
   - Archive data on cheap object storage (slow, 3+ years retention)
   - Saves ~80% on storage costs vs. keeping all data hot

5. **Resilience and Fault Tolerance**
   - Multiple availability zones for gateway and processor
   - Kafka replication factor 3 (no message loss on broker failure)
   - MongoDB replica sets with automatic failover
   - Circuit breakers and retry logic with exponential backoff

**Critical Success Factors:**
- Sub-second latency for telemetry ingestion (vehicle safety depends on real-time monitoring)
- Zero data loss during ingestion (regulatory and safety requirements)
- 20x scalability within 12 months (10K → 200K vehicles)
- Cost-effective storage at petabyte scale (~$650 TB archive data)

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

## Technology Decisions

### Technology Stack Summary

| Component                     | Technology              | Version   | Rationale                                                                           |
| ----------------------------- | ----------------------- | --------- | ----------------------------------------------------------------------------------- |
| **Telemetry Gateway**         | Node.js                 | 18+ LTS   | High performance, async I/O, team expertise (JavaScript), excellent Kafka client    |
| **Telemetry Processor**       | Node.js                 | 18+ LTS   | Consistent with gateway, great Kafka support, fast JSON processing                  |
| **Telemetry Pipeline**        | Apache Kafka            | 3.5+      | Industry standard for streaming, high throughput (7K msg/sec), message durability   |
| **Operational Data Store**    | MongoDB                 | 6.0+      | Schema-less (flexible message structure), high write throughput, TTL indexes        |
| **Archive Data Store**        | Azure Blob Storage      | N/A       | Cost-effective at petabyte scale ($0.01/GB), virtually unlimited, Azure integration |
| **Data Warehouse**            | Azure Synapse Analytics | N/A       | Optimized for analytical queries, integrates with Blob Storage, Power BI compatible |
| **Telemetry Viewer Backend**  | Node.js + Express       | 18+ / 4.x | REST API framework, team expertise, fast MongoDB queries                            |
| **Telemetry Viewer Frontend** | React                   | 18+       | Component-based UI, team expertise, real-time dashboard updates                     |
| **Container Orchestration**   | Kubernetes              | 1.27+     | Auto-scaling, self-healing, multi-cloud portability                                 |
| **Monitoring**                | Prometheus + Grafana    | Latest    | Industry standard, rich metrics, alerting, Kubernetes integration                   |

### Key Technology Choices & Trade-offs

**1. Node.js for Application Services**

**Chosen**: Node.js (JavaScript runtime)

**Alternatives Considered**:
- **Python**: Team has Python expertise, but performance issues (GIL, slow JSON parsing)
- **Java/JVM**: Great performance, mature ecosystem, but team lacks expertise
- **Go**: Excellent performance, built for concurrency, but team unfamiliar

**Decision Factors**:
- **Performance**: Event-driven, non-blocking I/O perfect for high-throughput messaging (7K msg/sec)
- **Team Expertise**: Team already uses JavaScript (easy transition from Python/JS background)
- **Kafka Integration**: Excellent Kafka client libraries (KafkaJS, node-rdkafka)
- **JSON Processing**: Native JavaScript object handling (no serialization overhead)
- **Linux Deployment**: Runs efficiently on Linux (company standard OS)

**Trade-offs Accepted**:
- Single-threaded (mitigated by running multiple instances)
- Less mature than Java ecosystem (acceptable given strong community)

---

**2. Apache Kafka for Telemetry Pipeline**

**Chosen**: Apache Kafka

**Alternatives Considered**:
- **RabbitMQ**: Easier setup, mature, good for simple queues
- **AWS Kinesis**: Managed service, no infrastructure management
- **Azure Event Hubs**: Native Azure integration

**Decision Factors**:
- **Throughput**: Kafka handles millions of messages/sec (7K msg/sec easily within capacity)
- **Durability**: Replication and persistence ensure no message loss
- **Scalability**: Horizontal scaling via partitions (10K → 200K vehicle growth)
- **Industry Standard**: Proven at scale (LinkedIn, Uber, Netflix use Kafka)
- **Multi-Consumer**: Multiple consumer groups (processor, analytics, monitoring) read same stream
- **Replay**: Message retention allows reprocessing for recovery or backfill

**Comparison Table**:

| Feature                    | Kafka                   | RabbitMQ              | AWS Kinesis                   |
| -------------------------- | ----------------------- | --------------------- | ----------------------------- |
| **Throughput**             | Millions msg/sec        | Thousands msg/sec     | Hundreds of thousands msg/sec |
| **Durability**             | High (replication)      | Medium                | High (managed)                |
| **Scalability**            | Horizontal (partitions) | Vertical + clustering | Horizontal (shards)           |
| **Operational Complexity** | High (self-managed)     | Medium                | Low (managed)                 |
| **Cost**                   | Moderate (self-hosted)  | Low (self-hosted)     | High (per shard)              |
| **Message Replay**         | Yes                     | No                    | Yes (limited 7 days)          |
| **Multi-Consumer**         | Yes (consumer groups)   | Yes (exchanges)       | Yes (enhanced fan-out)        |

**Trade-offs Accepted**:
- Complex setup and operations (mitigated by Kubernetes and ops training)
- Requires ZooKeeper (Kafka 3.x can run without ZooKeeper in KRaft mode)

---

**3. MongoDB for Operational Data Store**

**Chosen**: MongoDB (NoSQL document database)

**Alternatives Considered**:
- **PostgreSQL**: Strong ACID, great for structured data
- **Cassandra**: Write-optimized, distributed, time-series support
- **TimescaleDB**: PostgreSQL extension for time-series data
- **InfluxDB**: Purpose-built time-series database

**Decision Factors**:
- **Schema-less**: Messages from different vehicle models have different fields (no fixed schema)
- **High Write Throughput**: Handles 7K writes/sec easily
- **Fast Reads**: Indexed queries by vehicle ID and timestamp (< 100ms)
- **TTL Support**: Native TTL indexes automatically delete data after 7 days (no manual cleanup)
- **Team Expertise**: Operations team familiar with NoSQL databases
- **Simple Queries**: No complex joins needed (just fetch by vehicle ID + time range)

**Trade-offs Accepted**:
- No ACID transactions across documents (acceptable—telemetry data independent)
- Storage overhead from flexible schema (acceptable given SSD cost)
- Limited analytical capabilities (solved by separate data warehouse)

---

**4. Azure Blob Storage for Archive**

**Chosen**: Azure Blob Storage (cold storage tier)

**Alternatives Considered**:
- **AWS S3 Glacier**: Cheaper but slower retrieval
- **Google Cloud Storage Coldline**: Similar pricing and features
- **Self-Hosted HDD Storage**: Lower cost but high operational burden

**Decision Factors**:
- **Cost**: $0.01/GB/month (vs. $0.10/GB for SSD) = 90% savings
- **Scale**: Virtually unlimited storage (handles 650+ TB easily)
- **Azure Integration**: Company already uses Azure (single bill, IAM, networking)
- **Retrieval Speed**: Cool/Cold tier acceptable for BI queries (not real-time)
- **Durability**: 99.999999999% durability (11 nines)

**Trade-offs Accepted**:
- Slower access than operational store (acceptable—archive queried infrequently)
- Network egress costs (mitigated by keeping data warehouse in same region)

---

**5. Third-Party BI Tool (Not Building Custom)**

**Chosen**: Use existing BI tool (Power BI, Tableau, Looker)

**Rationale**:
- **Best Practice**: Never build BI platform from scratch
- **Expertise**: BI solution design requires BI specialists (not architects)
- **Market Maturity**: Existing tools have decades of development (visualization, OLAP, collaboration)
- **Time to Market**: Evaluating and configuring existing tool = weeks vs. building custom = years

**Architect's Role**:
- Design data warehouse schema (star/snowflake schema)
- Ensure data warehouse integrates with chosen BI tool
- Define data refresh schedules and aggregation logic
- BI team selects specific tool based on: features, cost, user training, vendor support

## Architecture Diagrams

### Logic Diagram (High-Level Data Flow)

```
[10,000+ Autonomous Vehicles on Road]
            |
            | TCP Connection (7K msg/sec)
            | Telemetry: location, speed, diagnostics, errors
            ▼
    ┌───────────────────┐
    │ Telemetry Gateway │ (Node.js - Load Balanced)
    │  - Receive TCP    │
    │  - Validate       │
    │  - Push to Kafka  │
    └─────────┬─────────┘
              │
              ▼
    ┌───────────────────────┐
    │  Telemetry Pipeline   │ (Apache Kafka)
    │  - Message Queue      │
    │  - Durability         │
    │  - Buffering          │
    └─────────┬─────────────┘
              │
              │ Poll messages
              ▼
    ┌───────────────────────┐
    │  Telemetry Processor  │ (Node.js - Multiple Instances)
    │  - Consume from Kafka │
    │  - Validate & Enrich  │
    │  - Write to Stores    │
    └──────┬────────┬───────┘
           │        │
           │        │ Archive
           │        │ (After 7 days)
           ▼        ▼
  ┌─────────────┐  ┌──────────────────┐
  │ Operational │  │  Archive Store   │
  │ Data Store  │  │ (Azure Blob)     │
  │ (MongoDB)   │  │ - Cold Storage   │
  │ - 7 days    │  │ - 3+ years       │
  │ - Hot data  │  │ - 650 TB         │
  └──────┬──────┘  └────────┬─────────┘
         │                  │
         │                  │ ETL
         ▼                  ▼
  ┌─────────────┐   ┌──────────────────┐
  │ Telemetry   │   │  Data Warehouse  │
  │   Viewer    │   │ (Azure Synapse)  │
  │ (Node+React)│   │ - Aggregated     │
  │             │   │ - Analytical     │
  └──────┬──────┘   └────────┬─────────┘
         │                   │
         ▼                   ▼
  [Operations Team]   ┌──────────────────┐
  - Real-time        │  BI & Analytics  │
    dashboards       │  (Power BI)      │
  - Vehicle health   │ - Reports        │
  - Error alerts     │ - Trends         │
                     │ - ML models      │
                     └──────────────────┘
                            │
                            ▼
                     [Data Scientists]
                     [Business Analysts]
```

---

### Physical Diagram (Deployment Architecture)

```
┌──────────────────────────────────────────────────────────────────────┐
│                      KUBERNETES CLUSTER (AKS)                        │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Telemetry Gateway Deployment (Node.js Pods)               │    │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐      │    │
│  │  │ Gateway │  │ Gateway │  │ Gateway │  │ Gateway │      │    │
│  │  │  Pod 1  │  │  Pod 2  │  │  Pod 3  │  │  Pod 4  │      │    │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘      │    │
│  │  (Auto-scaling: 4-20 pods based on msg/sec)               │    │
│  └──────────────────┬─────────────────────────────────────────┘    │
│                     │                                               │
│                     ▼                                               │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Apache Kafka Cluster (StatefulSet)                        │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │    │
│  │  │  Broker  │  │  Broker  │  │  Broker  │                 │    │
│  │  │    1     │  │    2     │  │    3     │                 │    │
│  │  └──────────┘  └──────────┘  └──────────┘                 │    │
│  │  (Replication Factor: 3, Partitions: 10)                   │    │
│  │  (Persistent Volumes: Azure Managed Disks)                 │    │
│  └──────────────────┬─────────────────────────────────────────┘    │
│                     │                                               │
│                     ▼                                               │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Telemetry Processor Deployment (Node.js Pods)             │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │    │
│  │  │Processor │  │Processor │  │Processor │                 │    │
│  │  │  Pod 1   │  │  Pod 2   │  │  Pod 3   │                 │    │
│  │  └──────────┘  └──────────┘  └──────────┘                 │    │
│  │  (Consumer Group, Auto-scaling: 3-15 pods)                 │    │
│  └──────────┬────────────────────────┬────────────────────────┘    │
│             │                        │                              │
│             ▼                        ▼                              │
│  ┌──────────────────┐    ┌─────────────────────────────────┐      │
│  │ MongoDB Cluster  │    │  Telemetry Viewer Deployment    │      │
│  │ (StatefulSet)    │    │  ┌────────┐  ┌────────┐         │      │
│  │ ┌──────┐┌──────┐│    │  │ Viewer │  │ Viewer │         │      │
│  │ │Primary││Secondary│   │  │ Pod 1  │  │ Pod 2  │         │      │
│  │ └──────┘└──────┘│    │  └────────┘  └────────┘         │      │
│  │ ┌──────┐        │    │  (Load Balanced)                 │      │
│  │ │Secondary     │    └────────────────┬────────────────┘      │
│  │ └──────┘        │                    │                        │
│  │ (Replica Set)   │                    │ HTTPS                  │
│  └─────────────────┘                    │                        │
│                                          │                        │
└──────────────────────────────────────────┼────────────────────────┘
                                          │
                                          ▼
                                  ┌──────────────┐
                                  │ Load Balancer│
                                  │  (Ingress)   │
                                  └──────┬───────┘
                                         │
                                         ▼
                              [Operations Team Browsers]

┌──────────────────────────────────────────────────────────────────────┐
│                      AZURE CLOUD SERVICES                            │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Azure Blob Storage (Archive)                              │    │
│  │  - Cool Tier: 650+ TB                                      │    │
│  │  - Partitioned by Date: /year/month/day/hour               │    │
│  │  - Compressed: Parquet format                              │    │
│  └──────────────────────┬─────────────────────────────────────┘    │
│                         │                                           │
│                         │ ETL (Nightly)                             │
│                         ▼                                           │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Azure Synapse Analytics (Data Warehouse)                  │    │
│  │  - Star Schema: Facts (telemetry) + Dimensions (vehicles)  │    │
│  │  - Optimized for OLAP queries                              │    │
│  └──────────────────────┬─────────────────────────────────────┘    │
│                         │                                           │
│                         ▼                                           │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Power BI Service                                          │    │
│  │  - Dashboards & Reports                                     │    │
│  │  - Scheduled Data Refresh                                   │    │
│  └────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

### Technical Diagram (Message Processing Flow)

```
Vehicle Telemetry Message Lifecycle

┌──────────────┐
│   Vehicle    │
│  (Autonomous)│
└──────┬───────┘
       │
       │ TCP: {"vehicleId": "CAR-123", "speed": 65, 
       │       "location": {"lat": 37.7749, "lon": -122.4194},
       │       "timestamp": "2026-01-08T10:30:00Z", "errors": []}
       ▼
┌──────────────────┐
│ Telemetry Gateway│ (Node.js)
└────────┬─────────┘
         │ 1. Receive TCP message
         │ 2. Parse JSON
         │ 3. Basic validation (non-empty, valid JSON)
         │ 4. Publish to Kafka
         ▼
┌────────────────────┐
│  Kafka Topic:      │
│  "vehicle-telemetry"│
│  Partition: Hash(vehicleId) % 10
└────────┬───────────┘
         │ Message stored with replication factor 3
         │ Retention: 7 days (allows replay)
         │
         │ Poll (Consumer Group: "telemetry-processors")
         ▼
┌───────────────────────┐
│ Telemetry Processor   │ (Node.js)
└─────────┬─────────────┘
          │ 1. Consume message from Kafka
          │ 2. Validate schema (required fields present)
          │ 3. Enrich (add processing timestamp)
          │ 4. Determine storage target
          │
          ├──────────────────┐
          │                  │
          ▼                  ▼
┌──────────────────┐  ┌──────────────────┐
│  MongoDB         │  │  Archive Process │
│  (Operational)   │  │  (Batch, Nightly)│
└──────────────────┘  └─────────┬────────┘
          │                     │
          │ Write                │ 1. Query MongoDB for day-old data
          │ {                    │ 2. Aggregate by vehicle + hour
          │   vehicleId,         │ 3. Compress (Parquet format)
          │   timestamp,         │ 4. Upload to Azure Blob
          │   speed,             │ 5. Delete from MongoDB (7-day TTL)
          │   location,          │
          │   errors,            ▼
          │   _ttl: 7 days   ┌──────────────────────────┐
          │ }                │  Azure Blob Storage      │
          │                  │  Path: /2026/01/08/      │
          │                  │  File: telemetry-10.parquet
          │                  └─────────┬────────────────┘
          │                            │
          │                            │ ETL (Weekly)
          ▼                            │
┌──────────────────┐                  ▼
│ Telemetry Viewer │         ┌────────────────────────┐
│ (Query API)      │         │  Azure Synapse         │
└──────────────────┘         │  Data Warehouse        │
          │                  └────────┬───────────────┘
          │ Query                     │
          │ GET /api/v1/telemetry/CAR-123
          │ db.telemetry.find({        │ Query
          │   vehicleId: "CAR-123",    │ SELECT AVG(speed)
          │   timestamp: {             │ FROM telemetry
          │     $gte: now - 1hour      │ WHERE vehicle_model = 'ModelX'
          │   }                        │ GROUP BY date
          │ }).sort({timestamp:-1})    │
          │                            ▼
          ▼                   ┌────────────────────┐
    [Operations Team]         │   Power BI         │
    Dashboard:                │   Dashboard        │
    - CAR-123 last seen       │   - Avg speed trend│
    - Speed: 65 mph           │   - Breakdown rate │
    - Location: SF            │   - Miles driven   │
    - Errors: None            └────────────────────┘
                                     │
                                     ▼
                              [Data Scientists]
                              [Business Analysts]
```

## Data Architecture

### Database Schema Design

**MongoDB Collections (Operational Data Store):**

```javascript
// Collection: telemetry
{
  _id: ObjectId("..."),
  vehicleId: "CAR-123",
  timestamp: ISODate("2026-01-08T10:30:00Z"),
  location: {
    lat: 37.7749,
    lon: -122.4194,
    altitude: 15.5  // meters
  },
  speed: 65,  // mph
  acceleration: 0.5,  // m/s²
  diagnostics: {
    cpuUsage: 45,  // percent
    memoryUsage: 60,  // percent
    diskSpace: 85,  // GB available
    sensorStatus: {
      lidar: "operational",
      camera: "operational",
      radar: "operational"
    }
  },
  errors: [
    {
      code: "WARN-001",
      message: "High CPU usage detected",
      severity: "warning",
      timestamp: ISODate("2026-01-08T10:29:55Z")
    }
  ],
  driverInterventions: 0,  // count in last hour
  processingTimestamp: ISODate("2026-01-08T10:30:01Z"),
  _ttl: ISODate("2026-01-15T10:30:00Z")  // 7 days from timestamp
}

// Indexes
db.telemetry.createIndex({ vehicleId: 1, timestamp: -1 })  // Primary query pattern
db.telemetry.createIndex({ timestamp: 1 })  // Range queries, archival
db.telemetry.createIndex({ "errors.severity": 1, timestamp: -1 })  // Error dashboard
db.telemetry.createIndex({ _ttl: 1 }, { expireAfterSeconds: 0 })  // TTL for auto-deletion
```

**Azure Blob Storage (Archive):**

```
Container: vehicle-telemetry-archive
Path Structure: /{year}/{month}/{day}/{hour}/telemetry-{partition}.parquet

Example:
/2026/01/08/10/telemetry-0.parquet
/2026/01/08/10/telemetry-1.parquet
...

Parquet Schema (Columnar format for analytics):
- vehicleId: STRING
- timestamp: TIMESTAMP
- location_lat: DOUBLE
- location_lon: DOUBLE
- speed: DOUBLE
- acceleration: DOUBLE
- cpu_usage: INT
- memory_usage: INT
- error_count: INT
- error_codes: ARRAY<STRING>
- driver_interventions: INT
```

**Data Warehouse Schema (Star Schema):**

```sql
-- Fact Table: telemetry_facts
CREATE TABLE telemetry_facts (
    fact_id BIGINT PRIMARY KEY,
    vehicle_key INT FOREIGN KEY REFERENCES dim_vehicles(vehicle_key),
    date_key INT FOREIGN KEY REFERENCES dim_date(date_key),
    time_key INT FOREIGN KEY REFERENCES dim_time(time_key),
    location_key INT FOREIGN KEY REFERENCES dim_locations(location_key),
    
    -- Measures (aggregated per hour)
    avg_speed DECIMAL(5,2),
    max_speed DECIMAL(5,2),
    min_speed DECIMAL(5,2),
    total_distance DECIMAL(10,2),  -- miles
    error_count INT,
    critical_error_count INT,
    driver_interventions INT,
    avg_cpu_usage DECIMAL(5,2),
    avg_memory_usage DECIMAL(5,2)
);

-- Dimension: dim_vehicles
CREATE TABLE dim_vehicles (
    vehicle_key INT PRIMARY KEY,
    vehicle_id VARCHAR(50) UNIQUE,
    vehicle_model VARCHAR(100),
    manufacture_year INT,
    installation_date DATE,
    software_version VARCHAR(50)
);

-- Dimension: dim_date
CREATE TABLE dim_date (
    date_key INT PRIMARY KEY,
    full_date DATE,
    year INT,
    quarter INT,
    month INT,
    day INT,
    day_of_week INT,
    is_weekend BOOLEAN
);

-- Dimension: dim_time
CREATE TABLE dim_time (
    time_key INT PRIMARY KEY,
    hour INT,
    minute INT,
    time_period VARCHAR(10)  -- morning, afternoon, evening, night
);

-- Dimension: dim_locations
CREATE TABLE dim_locations (
    location_key INT PRIMARY KEY,
    city VARCHAR(100),
    state VARCHAR(50),
    country VARCHAR(50),
    region VARCHAR(100)  -- geographic region for grouping
);
```

### Data Flow & ETL Process

**Real-Time Data Flow (Hot Path):**
1. Vehicle → Gateway → Kafka → Processor → MongoDB (< 1 second)
2. Viewer queries MongoDB directly for real-time dashboards

**Batch Data Flow (Cold Path):**

**Nightly Archive Job (runs at 2 AM):**
```javascript
// Pseudo-code for archive processor
function archiveTelemetryData() {
  // 1. Query MongoDB for yesterday's data
  const yesterday = new Date(Date.now() - 24*60*60*1000);
  const data = db.telemetry.find({
    timestamp: {
      $gte: startOfDay(yesterday),
      $lt: endOfDay(yesterday)
    }
  });
  
  // 2. Group by hour and vehicle
  const aggregated = aggregateByHour(data);
  
  // 3. Convert to Parquet format
  const parquet = convertToParquet(aggregated);
  
  // 4. Upload to Azure Blob Storage
  const path = `/telemetry-archive/${yesterday.getFullYear()}/` +
               `${yesterday.getMonth()+1}/${yesterday.getDate()}/`;
  azureBlob.upload(path, parquet);
  
  // 5. MongoDB TTL index automatically deletes after 7 days
  // (No manual deletion needed)
}
```

**Weekly Data Warehouse Refresh (runs Sunday 3 AM):**
```sql
-- ETL: Load new week's data from Blob Storage to Synapse
COPY INTO telemetry_facts
FROM 'https://storage.blob.core.windows.net/telemetry-archive/2026/01/*'
WITH (
    FILE_TYPE = 'PARQUET',
    CREDENTIAL = (IDENTITY = 'Managed Identity')
);

-- Update aggregations
INSERT INTO telemetry_facts (...)
SELECT
    v.vehicle_key,
    d.date_key,
    t.time_key,
    l.location_key,
    AVG(telemetry.speed) as avg_speed,
    MAX(telemetry.speed) as max_speed,
    ...
FROM blob_staging_telemetry telemetry
JOIN dim_vehicles v ON telemetry.vehicleId = v.vehicle_id
JOIN dim_date d ON DATE(telemetry.timestamp) = d.full_date
...
GROUP BY v.vehicle_key, d.date_key, t.time_key, l.location_key;
```

### Data Retention & Lifecycle

| Data Type          | Location      | Retention | Storage Type  | Cost     | Purpose               |
| ------------------ | ------------- | --------- | ------------- | -------- | --------------------- |
| **Real-Time**      | MongoDB       | 7 days    | SSD (Premium) | $0.10/GB | Operations dashboards |
| **Archive**        | Azure Blob    | 3 years   | HDD (Cool)    | $0.01/GB | BI, ML, compliance    |
| **Data Warehouse** | Azure Synapse | 3 years   | Optimized     | $0.05/GB | Analytics queries     |

**Total Storage Costs:**
- Operational: 4.5 TB × $0.10/GB = $450/month
- Archive: 650 TB × $0.01/GB = $6,500/month
- Data Warehouse: 100 TB × $0.05/GB = $5,000/month
- **Total: ~$12,000/month** (vs. $65,000 if all data on SSD)

## Security Architecture

### Authentication & Authorization

**Vehicle Authentication:**
- **Method**: Mutual TLS (mTLS) with client certificates
- **Flow**:
  1. Each vehicle issued unique X.509 certificate during kit installation
  2. Vehicle presents certificate when connecting to Gateway
  3. Gateway validates certificate against Certificate Authority (CA)
  4. Only authenticated vehicles can send telemetry
- **Certificate Rotation**: Annual renewal with automated rollout to vehicles

**User Authentication (Telemetry Viewer):**
- **Method**: Azure Active Directory (AAD) SSO + RBAC
- **Roles**:
  - **Viewer**: Read-only access to dashboards (operations team)
  - **Admin**: Full access + system configuration (DevOps)
  - **Analyst**: Read-only access to data warehouse (data scientists)
- **Flow**:
  1. User logs in via AAD (company SSO)
  2. Viewer backend validates JWT token
  3. RBAC checks user role before serving data

### Data Protection

**Data in Transit:**
- **Vehicle → Gateway**: TLS 1.3 (encrypted TCP)
- **Gateway → Kafka**: TLS (encrypted broker connections)
- **Processor → MongoDB**: TLS (encrypted database connections)
- **Viewer → Users**: HTTPS/TLS 1.3
- **Processor → Azure Blob**: HTTPS (Azure SDK with encryption)

**Data at Rest:**
- **Kafka**: Encryption at rest enabled (AES-256)
- **MongoDB**: Encryption at rest enabled (AES-256, WiredTiger engine)
- **Azure Blob Storage**: Server-side encryption (SSE) enabled by default
- **Azure Synapse**: Transparent Data Encryption (TDE) enabled

**Sensitive Data Handling:**
- **PII**: Vehicle locations considered PII (encrypted, access-controlled)
- **Anonymization**: For ML model training, vehicle IDs hashed
- **Access Logs**: All data access logged for audit

### Network Security

**Firewall Rules:**
- Gateway: Public IP (accepts TCP from vehicles), whitelist by IP range if possible
- Kafka: Private network only (not exposed to internet)
- MongoDB: Private network only (accessed by processor and viewer)
- Viewer: Public HTTPS via load balancer (WAF enabled)

**DDoS Protection:**
- Azure DDoS Protection Standard enabled
- Rate limiting: 100 messages/sec per vehicle (drop excess)

**Compliance:**
- **GDPR**: Vehicle location data = personal data (encryption, retention limits, right to erasure)
- **ISO 27001**: Security management system for automotive data
- **SOC 2 Type II**: Audit controls for data protection

## Backup & Disaster Recovery

### Backup Strategy

**Kafka Backups:**
- **Message Retention**: 7 days on-disk (allows replay after failure)
- **No Traditional Backup**: Kafka itself is the durable store
- **Replication**: 3 replicas per partition (survives 2 broker failures)

**MongoDB Backups:**
- **Continuous Backup**: Percona Backup for MongoDB (every 6 hours)
- **Retention**: 30 days
- **Storage**: Azure Blob Storage (separate region)
- **Point-in-Time Recovery**: Down to 1-second granularity

**Azure Blob Storage (Archive):**
- **Replication**: LRS (Locally Redundant Storage) = 3 copies in same datacenter
- **Optional**: GRS (Geo-Redundant Storage) for critical data = 6 copies across regions
- **Soft Delete**: 14-day retention for accidental deletions

### Disaster Recovery Plan

**Scenarios & Procedures:**

**Scenario 1: Kafka Broker Failure**
- **Detection**: Broker health check fails
- **RTO**: 0 (automatic failover)
- **RPO**: 0 (replicas have all data)
- **Procedure**: 
  1. Kafka controller promotes replica to leader
  2. Producers/consumers automatically reconnect to new leader
  3. No manual intervention required

**Scenario 2: MongoDB Primary Failure**
- **Detection**: Primary health check fails
- **RTO**: 30 seconds (automatic election)
- **RPO**: < 1 second (oplog replication)
- **Procedure**:
  1. Replica set elects new primary
  2. Application reconnects to new primary
  3. Monitor replication lag on new primary

**Scenario 3: Complete Region Failure**
- **Detection**: All services in region unreachable
- **RTO**: 2 hours (manual failover)
- **RPO**: 6 hours (last MongoDB backup)
- **Procedure**:
  1. Restore MongoDB backup in different region
  2. Deploy Kubernetes cluster in new region
  3. Update DNS to point to new region
  4. Recent data (< 6 hours) from Kafka replayed

**Scenario 4: Gateway Overload (Traffic Spike)**
- **Detection**: CPU > 85%, message latency increasing
- **RTO**: 5 minutes (auto-scaling)
- **RPO**: 0 (Kafka buffers messages)
- **Procedure**:
  1. Kubernetes auto-scaler adds gateway pods
  2. Load balancer distributes to new pods
  3. Kafka queue drains as capacity increases

## Monitoring & Observability

### Key Metrics & Alerts

**Application Metrics:**

| Metric                | Threshold        | Alert Level | Action                  |
| --------------------- | ---------------- | ----------- | ----------------------- |
| Gateway Message Rate  | < 5000 msg/sec   | Info        | Normal operation        |
| Gateway Message Rate  | > 8000 msg/sec   | Warning     | Prepare to scale        |
| Gateway Message Rate  | > 10000 msg/sec  | Critical    | Auto-scale triggered    |
| Kafka Consumer Lag    | > 10000 messages | Warning     | Scale processors        |
| Kafka Consumer Lag    | > 50000 messages | Critical    | Immediate investigation |
| MongoDB Write Latency | > 10ms (p95)     | Warning     | Check disk I/O          |
| MongoDB Write Latency | > 50ms (p95)     | Critical    | Scale MongoDB           |
| Processor Error Rate  | > 1%             | Warning     | Check logs              |
| Processor Error Rate  | > 5%             | Critical    | Rollback deployment     |
| Viewer API Latency    | > 200ms (p95)    | Warning     | Optimize queries        |
| Viewer API Latency    | > 500ms (p95)    | Critical    | Add read replicas       |

**Infrastructure Metrics:**

| Metric               | Threshold | Alert Level | Action                 |
| -------------------- | --------- | ----------- | ---------------------- |
| CPU Utilization      | > 70%     | Warning     | Prepare to scale       |
| CPU Utilization      | > 85%     | Critical    | Auto-scale             |
| Memory Utilization   | > 80%     | Warning     | Investigate leaks      |
| Disk Space (MongoDB) | > 80%     | Warning     | Trigger archival       |
| Disk Space (Kafka)   | > 85%     | Critical    | Purge old logs         |
| Network Throughput   | > 8 Gbps  | Warning     | Check bandwidth limits |

**Business Metrics (Dashboards):**
- Total vehicles online (real-time count)
- Messages received per second (should match ~7K)
- Error rate by vehicle model (quality issues)
- Average vehicle speed by region (traffic patterns)
- Data warehouse freshness (last ETL run timestamp)

### Logging Strategy

**Centralized Logging:**
- **Tool**: ELK Stack (Elasticsearch, Logstash, Kibana) or Azure Monitor
- **Log Levels**: DEBUG (dev), INFO (prod), WARN, ERROR
- **Log Format**: JSON structured logs

**What to Log:**

**Gateway:**
- Connection events (vehicle connected, disconnected)
- Message received (vehicle ID, timestamp, size)
- Kafka publish success/failure

**Processor:**
- Message consumed (vehicle ID, Kafka offset)
- Validation errors (missing fields, invalid data)
- Database write success/failure

**Example Log Entry:**
```json
{
  "timestamp": "2026-01-08T10:30:15.123Z",
  "level": "INFO",
  "service": "telemetry-gateway",
  "instanceId": "gateway-pod-3",
  "vehicleId": "CAR-123",
  "action": "message_received",
  "messageSize": 1024,
  "kafkaTopic": "vehicle-telemetry",
  "kafkaPartition": 3,
  "duration_ms": 5
}
```

**Retention:**
- INFO logs: 30 days
- ERROR logs: 90 days

### Distributed Tracing

**Tool**: Jaeger or Azure Application Insights

**Trace Scenario**: Vehicle message end-to-end
- Span 1: Vehicle → Gateway (TCP receive)
- Span 2: Gateway → Kafka (publish)
- Span 3: Processor consumes from Kafka
- Span 4: Processor → MongoDB (write)
- Span 5: Viewer API query → MongoDB (read)

**Benefits**: Identify bottlenecks (e.g., slow MongoDB writes)

## Deployment Strategy

### CI/CD Pipeline

**Build & Test:**
1. Code commit → GitHub
2. GitHub Actions triggered
3. Run unit tests (Jest for Node.js)
4. Build Docker images (Gateway, Processor, Viewer)
5. Push to Azure Container Registry (ACR)

**Deployment:**
1. Kubernetes manifest updated with new image tag
2. Deploy to staging environment
3. Run integration tests (send test telemetry, verify in MongoDB)
4. Manual approval gate
5. Rolling deployment to production (25% → 50% → 100%)
6. Monitor metrics for 15 minutes, rollback if errors

### Environment Strategy

| Environment     | Purpose           | Data                           | Deployment         |
| --------------- | ----------------- | ------------------------------ | ------------------ |
| **Development** | Developer testing | Synthetic data                 | On every commit    |
| **Staging**     | Pre-production    | Copy of production (sanitized) | Daily              |
| **Production**  | Live system       | Real vehicle data              | Weekly (Fri 10 PM) |

## Performance & Scalability

### Performance Benchmarks

**Current Performance (10K vehicles):**
- Ingestion rate: 7,000 msg/sec
- Gateway latency: 5ms (p95)
- Processor latency: 50ms (p95)
- MongoDB write latency: 8ms (p95)
- Viewer API latency: 120ms (p95)

**Target Performance (200K vehicles - 20x scale):**
- Ingestion rate: 140,000 msg/sec
- Gateway latency: < 10ms (p95)
- Processor latency: < 100ms (p95)
- MongoDB write latency: < 20ms (p95)
- Viewer API latency: < 200ms (p95)

### Scalability Strategy

**Horizontal Scaling Plan:**

| Component            | Current         | Target (200K vehicles) | Scaling Method                          |
| -------------------- | --------------- | ---------------------- | --------------------------------------- |
| **Gateway Pods**     | 4               | 80                     | Kubernetes HPA (CPU-based)              |
| **Kafka Brokers**    | 3               | 10                     | Add brokers, repartition                |
| **Kafka Partitions** | 10              | 50                     | Increase partitions (planning required) |
| **Processor Pods**   | 3               | 60                     | Kubernetes HPA (consumer lag)           |
| **MongoDB Shards**   | 1 (replica set) | 5 shards               | Horizontal sharding by vehicleId        |
| **Viewer Pods**      | 2               | 10                     | Kubernetes HPA (CPU-based)              |

**MongoDB Sharding Strategy:**
- **Shard Key**: `vehicleId` (evenly distributes data)
- **Shard Count**: 5 shards at 200K vehicles
- **Each Shard**: 3-node replica set

## Testing Strategy

### Unit Testing
- **Coverage**: 80% target
- **Framework**: Jest (Node.js)
- **Focus**: Business logic (validation, transformation)

### Integration Testing
- **Scope**: Service interactions
- **Tools**: Testcontainers (Kafka, MongoDB in Docker)
- **Scenarios**:
  - Gateway → Kafka (message published)
  - Processor → MongoDB (data written)
  - Viewer → MongoDB (query returns correct data)

### Load Testing
- **Tool**: k6 or Apache JMeter
- **Scenarios**:
  - Normal load: 7K msg/sec for 1 hour
  - Peak load: 10K msg/sec for 30 minutes
  - Stress test: 15K msg/sec until failure

## Cost Analysis

**Monthly Infrastructure Cost Estimate:**

**Compute (Kubernetes - AKS):**
- Gateway pods: 4 × $50 = $200
- Processor pods: 3 × $50 = $150
- Viewer pods: 2 × $50 = $100

**Kafka:**
- 3 brokers × $200 (4 vCPU, 16GB RAM) = $600

**MongoDB:**
- Primary + 2 Secondaries × $300 = $900
- Storage: 5 TB × $0.10/GB = $500

**Azure Blob Storage:**
- 650 TB × $0.01/GB = $6,500

**Azure Synapse (Data Warehouse):**
- Compute: $2,000/month (pausable)
- Storage: 100 TB × $0.05/GB = $5,000

**Networking:**
- Data transfer: 100 TB/month × $0.05/GB = $5,000

**Monitoring:**
- Prometheus + Grafana: $200

**Total: ~$21,150/month** (~$253,800/year)

**Cost at 200K vehicles (20x scale):**
- Compute scales linearly: ~$20,000
- Kafka: ~$2,000
- MongoDB: ~$5,000 (sharding)
- Blob Storage: ~$130,000 (13 PB)
- Synapse: ~$10,000
- **Total: ~$167,000/month** (~$2M/year)

## Risks & Mitigation

**Risk 1: Kafka Operational Complexity**
- **Impact**: High (team unfamiliar with Kafka operations)
- **Mitigation**: Training, hire Kafka expert, managed Kafka (Azure Event Hubs) as alternative

**Risk 2: MongoDB Scaling Limits**
- **Impact**: Medium (single shard may hit write limits at 200K vehicles)
- **Mitigation**: Plan sharding early, test at 50K vehicles, consider Cassandra migration

**Risk 3: Data Warehouse Query Performance**
- **Impact**: Medium (slow BI queries frustrate analysts)
- **Mitigation**: Optimize star schema, pre-aggregate common queries, partition by date

**Risk 4: Vehicle Authentication Scalability**
- **Impact**: High (200K vehicles = 200K concurrent TLS connections)
- **Mitigation**: Gateway connection pooling, mTLS offloading to load balancer

## Future Enhancements

**Phase 2 (6-12 months):**
1. **Real-Time Alerts**: Push notifications to ops team on critical errors
2. **Predictive Maintenance**: ML models predict vehicle failures before they happen
3. **Geofencing**: Alert when vehicles enter restricted zones

**Phase 3 (1-2 years):**
1. **Multi-Region Deployment**: Deploy in EU, Asia for lower latency
2. **Real-Time Analytics**: Stream processing (Kafka Streams, Flink) for live dashboards
3. **Custom BI Dashboards**: Build internal dashboards (vs. relying on Power BI)

## Appendices

### Appendix A: Glossary

- **Apache Kafka**: Distributed streaming platform for high-throughput messaging
- **Consumer Group**: Kafka concept where multiple consumers share message processing
- **Lambda Architecture**: Pattern separating real-time (hot) and batch (cold) data processing
- **MongoDB TTL Index**: Index that automatically deletes documents after expiration time
- **Parquet**: Columnar file format optimized for analytics (used in data lakes)
- **Star Schema**: Data warehouse pattern with fact table (metrics) and dimension tables (attributes)

### Appendix B: API Reference

See [Services Drill Down - Telemetry Viewer](#telemetry-viewer) for API documentation.

### Appendix C: Deployment Runbook

**Standard Deployment**:
1. Merge PR to `main` branch
2. CI builds Docker images, runs tests
3. Deploy to staging, run integration tests
4. Approve production deployment
5. Rolling update (25% → 50% → 100%)
6. Monitor for 15 minutes, rollback if needed

**Rollback Procedure**:
```bash
# Rollback to previous image version
kubectl set image deployment/telemetry-gateway gateway=acr.io/gateway:v1.2.3
kubectl rollout status deployment/telemetry-gateway
```

## Document Control

- **Version**: 1.0
- **Last Updated**: 2026-01-08
- **Author**: Architecture Team
- **Reviewers**: CTO, Engineering Manager, DevOps Lead
- **Next Review Date**: 2026-04-08 (Quarterly)
- **Change Log**:
  - 2026-01-08: Initial comprehensive architecture document created