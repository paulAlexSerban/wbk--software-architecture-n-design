# Dunderly - Your Paper Source
> FROM: "Software Architecture Case Studies" on Udemy

## Overview
- this business sales paper supplies such as printer paper, envelopes, and notepads, as well as office supplies like pens, staplers, and organizers.
- the business expands and needs a new HR system to manage employee records, payroll, vacations, and benefits.

## Requirements
### Functional Requirements (What the system should do)
- web based
- perform CRUD operations on employee records
- manage salaries
  - asllow manager to ask for employee's salary change
  - allow HR manager to approve / reject requests
- manage vacation days
- use external payment system to process payroll
- generate reports for management

Functional Requirements Summary
- Web based
- Perform CRUD operations on employee records
- Manage salaries
  - allow manager to ask for employee's salary change
  - allow HR manager to approve / reject requests
- Manage vacation days
- Use external payment system to process payroll
- Generate reports for management

### Non-Functional Requirements (What the system should deal with)
What we know:
- classinc information system
- not a lot pf users
- not a lot of data
- there should be an interface to external system

What we ask?
- How many users will use the system concurrently?
  - ~10 users
- How many employees will be managed in the system?
  - ~250 employees
- What is the expected data growth over time?
-  - low growth rate
- What we know about the external payment system?
  - Legacy system, written in C++
  - Hosted on the company's own servers
  - Input - only via files (CSV) - no API, no DB connection
  - Files are received once a month

Data Volume
  - 1 employee record =~ 1 Mb
  - Each employee has =~ 10 scanned documents (contracts, certificates, etc.)
  - 1 scanned document =~ 5 Mb
  - Total storage per 1 employee =~ 1 + 10 * 5 = 51 Mb
  - Company expects to grow to 500 employees in the next 5 years
  - Total storage for 500 employees =~ 500 * 51 Mb = 25500 Mb = ~25 Gb
  - Not a lot of data, but:
    - Need to consider document storage and backup strategy
  .
SLA (Service Level Agreement)
  - How critical is the HR system for the business operations?
    - Not critical, but important
  - What is the acceptable downtime for the system?
    - Max 4 hours per month
  - What is the acceptable response time for user actions?
    - Max 2 seconds for any action
  - What are the backup and recovery requirements?
    - Daily backups
    - Recovery time objective (RTO) - max 4 hours
    - Recovery point objective (RPO) - max 1 hour

Non-Functional Requirements Summary
  - Low number of concurrent users (~10)
  - Management of ~500 employees
  - Low data volume (~25 Gb in 5 years)
    - Relational & Unstructured data (documents)
  - Not mission-critical system
  - File-based integration with legacy payment system

## Executive Summary
- Web-based HR system for managing employee records, salaries, and vacations.

![Diagram](./diagrams/components-n-messaging-system%20-%20logic%20diagram.png)

## Components
Based on [the requirements](#requirements), the following components can be identified for the HR system:

1. Employees Service
   - performs CRUD operations on employee records
   - manages employee documents
2. Salary Service
   - salary approval workflow
   - salary management
3. Vacation Service
   - employee's vacation management
4. View Service
   - returns static files to the browser (HTML, CSS, JS)
5. Payment System
6. Payment Interface
   - sends data to the payment system in the required format (CSV files)
7. Data store
  - Q: single or per service data store?
  - A: data is shared between services, so a single data store is preferred
8. Loggning & Monitoring Service
  - collects logs from all services

### Messaging System

### Scalling

## Services Drill Down

### Logging & Monitoring Service
Questions:
- Is there an exiting logging mechanism in the company? - No
  - The company so far designed silo systems that do not share logging mechanisms
- Should we develpo a custom logging solution or use an existing one? - Design a custom solution
  - Steps:
    - Decide an Appliation Type
    - Decide on Technology Stack
    - Design the Architecture
  - Application Type
    - What it does:
      - Read log records from queue
      - Handle the records (store, analyze, alert)
      - Save logs to persistent storage (database, file system, etc.)
    - Console OR Service
      - Console - NO GO - not suitable for production systems
      - Service - YES - suitable for production systems
  - Technology Stack
    - Programming Language / Components Code
      - What should the code do? - .NET Service - YES - already used in the company
        - Access Queue's API to read log records
        - Validate log records
        - Store log records in persistent storage
      - What us the curret technology stack in the company?
        - Backend - Microsoft stack (.NET, SQL Server)
    - Data Store - SQL Server - YES - already used in the company
      - What type of data store?
        - Relational Database - YES - suitable for structured log records
        - NoSQL Database - NO GO - not suitable for structured log records
  - Architecture Design
    - Long runnig process with no UI and no API exposed to the outside world.
    - Suggestion: Tweak the classic layered pattern
    - Layers:
      - Polling Layer
        - Responsible for reading log records from the queue system.
        - Should implement a polling mechanism to continuously check for new log records.
      - Business Layer
        - Responsible for processing log records.
        - Should perform record validation and any necessary transformations.
      - Data Access Layer
        - Responsible for storing log records in the database.
      - Data Store Layer
        - Represents the SQL Server database where log records are stored.
  - Redundancy & Scalability
    - Redundancy
      - Deploy 2 instances of the logging service.
      - Use Active-Active configuration.
      - Use Is-Alive mechanism to monitor instances and switch traffic if one instance fails to avoid duplicate log records.
    - Scalability
      - Use Queue system to decouple log producers from log consumers.
      - Scale out by adding more instances of the logging service as needed.

![Diagram](./diagrams/logging-service.png)

#### Logging - Alternative
- ELK Stack (Elasticsearch, Logstash, Kibana) - NO GO - it is an overkill for this case
  - Pros:
    - Powerful search and analytics capabilities (Elasticsearch)
    - Import log from many sources (Logstash)
    - Great viewer with filter capabilities (Kibana)
    - Scalable and flexible architecture
    - Open-source with a large community
  - Cons:
    - Requires setup and maintenance
    - Quite complicated to install and setup
    - Can be resource-intensive
    - Suitable mainly for large, data-intensive applications

### View Service
What it does:
- Get requests from the end user's browser
- Return static files (HTML, CSS, JS)
Application Type: Web App & Web API
Technology Stack:
- Programming Language / Components Code
  - What should the code do? - .NET Web API - YES - already used in the company, has great support for web applications
    - Handle HTTP requests
    - Return static files
  - What us the curret technology stack in the company?
    - Backend - Microsoft stack (.NET, SQL Server)
Architecture Design:
- Start from classic 3-Layered Pattern, and keep only the User Interface Layer (this is a fuly static service, that only serves static files).
- Layers:
  - User Interface Layer
    - Responsible for handling HTTP requests and returning static files to the browser.
View Service Redundancy & Scalability
- Redundancy
  - Deploy 2 instances of the View Service behind a Load Balancer.

### Employees Service
What it does:
- Allows end users to query employee records
- Allows performing actions on employee records (create, update, delete / CUD)
What it dose not do:
- Displays the data to the end user (this is the View Service's responsibility)
Application Type: Web API
Technology Stack:
- Programming Language / Components Code
  - What should the code do? - .NET Web API - YES - already used in the company
    - Handle HTTP requests
    - Perform CRUD operations on employee records
  - What us the curret technology stack in the company?
    - Backend - Microsoft stack (.NET, SQL Server)
- Database
  - Data types:
    - Relational Data - Employee records
    - Unstructured Data - Employee documents (scanned contracts, certificates, etc.)
      - Alternatives for Document (BLOG) Storage:
        - Relational Database
        - File System
        - Object Store
        - Cloud Storage

| Alternative         | Description                                                                   | Examples                                         | Pros                                   | Cons                           | Suitable for Dunderly?                      |
| ------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------- | ------------------------------ | ------------------------------------------- |
| Relational Database | Store documents in a specialized column type designed for BLOBs               | SQL Server, FILESTREAM, Oracle's BLOB type       | - Part of the app transaction          | - Clunky syntax                | YES - suitable for small data volume        |
|                     |                                                                               |                                                  | - Part of the DB's backup / DR process | - Limited size                 |                                             |
| File System         | Store documents as files on a file system, and hold a pointer to it in the DB | NFS, SMB, Local File System                      | - Simple to implement                  | - Backup/DR is separate        | NO GO - backup/DR complexity                |
|                     |                                                                               |                                                  | - Easy to access files                 | - Scalability                  |                                             |
|                     |                                                                               |                                                  |                                        | - Not part of the transaction  |                                             |
| Object Store        | Use special type of store mechanism that specialized in BLOBs                 | MinIO, Ceph, OpenStack Swift                     | - Scalable                             | - Additional component         | NO GO - adds complexity                     |
|                     |                                                                               |                                                  | - Designed for large files             | - Backup/DR is separate        |                                             |
|                     |                                                                               |                                                  |                                        | - Complex setup                |                                             |
| Cloud Storage       | Store documents one of the public cloud storage mechanisms                    | AWS S3, Azure Blob Storage, Google Cloud Storage | - Highly scalable                      | - Dependency on cloud provider | NO GO - adds complexity                     |
|                     |                                                                               |                                                  | - Managed service                      | - Cost                         | NO GO - not suitable for on-premise systems |
|                     |                                                                               |                                                  |                                        | - Requires internet connection |                                             |

  - Database Type:
    - Relational Database - YES - suitable for relational data, SQL Server is already used in the company
    - Document Store - YES - use SQL Server BLOB type for document storage, suitable for small data volume
Architecture Design:
- Start from classic 3-Layered Pattern
- Layers:
  - Service Interface Layer
    - Responsible for handling HTTP requests and returning responses to the client.
  - Business Layer
    - Responsible for processing business logic related to employee management.
  - Data Access Layer
    - Responsible for interacting with the database to perform CRUD operations on employee records.
  - Data Store Layer
    - Represents the SQL Server database where employee records and documents are stored.

API:
- What the API should do?
  - Get full employee details by ID
  - List of employees by parameters (name, department, etc.)
  - Add employee
  - Update employee details
  - Remove employee (no physical delete, only mark as inactive)
  - Add employee document
  - Remove employee document (no physical delete, only mark as inactive)
  - Get employee document by ID
  - Retrive documents by paramters (employee ID, document type, etc.)
> Q: Do we need a separare Document Handler Service?
> A: No, the document handling is closely tied to employee records, so it makes sense to keep it within the Employees Service.
> But: if we see in the future that multiple services need to access documents, we can consider extracting it into a separate service.

API Design:
| Functionality                | HTTP Method | Endpoint                                 | Return Codes  | Description                                      |
| ---------------------------- | ----------- | ---------------------------------------- | ------------- | ------------------------------------------------ |
| Get employee details by ID   | GET         | /api/v1/employee/{id}                    | 200, 404      | Retrieve full details of an employee by their ID |
| List employees by params     | GET         | /api/v1/employee?name=...&attributes=... | 200, 400      | Retrieve a list of employees based on parameters |
| Add employee                 | POST        | /api/v1/employee                         | 201, 400      | Create a new employee record                     |
| Update employee details      | PUT         | /api/v1/employee/{id}                    | 200, 400, 404 | Update details of an existing employee           |
| Remove employee              | DELETE      | /api/v1/employee/{id}                    | 200, 404      | Mark an employee as inactive                     |
| Add employee document        | POST        | /api/v1/employee/{id}/documents          | 201, 400, 404 | Add a document to an employee record             |
| Remove employee document     | DELETE      | /api/v1/employee/{id}/documents/{docId}  | 200, 404      | Mark a document as inactive                      |
| Get employee document by ID  | GET         | /api/v1/employee/{id}/documents/{docId}  | 200, 404      | Retrieve a specific document by its ID           |
| Retrieve documents by params | GET         | /api/v1/employee/{id}/documents?type=... | 200, 400      | Retrieve documents based on parameters           |

Employees Service Redundancy & Scalability
- Redundancy
  - Deploy 2 instances of the Employees Service behind a Load Balancer.

### Salary Service
What it does:
- Allows managers to ask for employee's salary change
- Allows HR representative to approve / reject requests
Application Type: Web API - sevice that expects requests and returns responses over HTTP
Technology Stack:
- Programming Language / Components Code
  - What should the code do? - .NET Web API - YES - already used in the company
    - Handle HTTP requests
    - Process salary change requests
  - What us the curret technology stack in the company?
    - Backend - Microsoft stack (.NET, SQL Server)

Architecture Design:
- Start from classic 3-Layered Pattern
- Layers:
  - Service Interface Layer
    - Responsible for handling HTTP requests and returning responses to the client.
  - Business Layer
    - Responsible for processing business logic related to salary management.
  - Data Access Layer
    - Responsible for interacting with the database to perform CRUD operations on salary records.
  - Data Store Layer
    - Represents the SQL Server database where salary records are stored.

API:
- What the API should do?
  - Add salary request
  - Remove salary request
  - Get saalry request
  - Approve salary request
  - Reject salary request

API Design:
| Functionality          | HTTP Method | Endpoint                                     | Return Codes | Description                               |
| ---------------------- | ----------- | -------------------------------------------- | ------------ | ----------------------------------------- |
| Add salary request     | POST        | /api/v1/salary/request                       | 201, 400     | Create a new salary change request        |
| Remove salary request  | DELETE      | /api/v1/salary/request/{requestId}           | 200, 404     | Remove a salary change request            |
| Get salary requests    | GET         | /api/v1/salary/requests                      | 200, 400     | Retrieve a list of salary change requests |
| Approve salary request | POST        | /api/v1/salary/request/{requestId}/approval  | 200, 404     | Approve a salary change request           |
| Reject salary request  | POST        | /api/v1/salary/request/{requestId}/rejection | 200, 404     | Reject a salary change request            |

> - Why "approval" and "rejection" instead of "approve" and "reject"?
>  - Because we are performing an action on the resource (salary request), so we use nouns instead of verbs in the endpoint.
>  - REST only deals with entities (resources), not actions (verbs).

### Vacation Service
What it does:
- Alows employees to manage their vacation days
- Allws HR to set available vacation days per employee
Application Type: Web API
Technology Stack:
- Programming Language / Components Code
  - What should the code do? - .NET Web API - YES - already used in the company
    - Handle HTTP requests
    - Process vacation management
  - What us the curret technology stack in the company?
    - Backend - Microsoft stack (.NET, SQL Server)
Architecture Design:
- Start from classic 3-Layered Pattern
- Layers:
  - Service Interface Layer
    - Responsible for handling HTTP requests and returning responses to the client.
  - Business Layer
    - Responsible for processing business logic related to vacation management.
  - Data Access Layer
    - Responsible for interacting with the database to perform CRUD operations on vacation records.
  - Data Store Layer
    - Represents the SQL Server database where vacation records are stored.
  
API:
- What the API should do?
  - Set availbale vacation days (by HR)
  - Get available vacation days
  - Reduce vacation days (by employees)

API Design:
| Functionality               | HTTP Method | Endpoint                                | Return Codes  | Description                                 |
| --------------------------- | ----------- | --------------------------------------- | ------------- | ------------------------------------------- |
| Set available vacation days | PUT         | /api/v1/vacation/{employeeId}           | 200, 400, 404 | Set available vacation days for an employee |
| Get available vacation days | GET         | /api/v1/vacation/{employeeId}           | 200, 404      | Get available vacation days for an employee |
| Reduce vacation days        | POST        | /api/v1/vacation/{employeeId}/reduction | 200, 400, 404 | Reduce vacation days for an employee        |

### Payment Interface
What it does:
- Queries the database once a month to get the salary data
- Passes payment data to the external payment system via CSV files
Application Type: Service - it is a long running process with no UI and no API exposed to the outside world.
Technology Stack:
- Programming Language / Components Code
  - What should the code do? - .NET Service - YES - already used in the company
    - Query the database to get salary data
    - Generate CSV files
    - Send files to the external payment system
  - What us the curret technology stack in the company?
    - Backend - Microsoft stack (.NET, SQL Server)
Architecture Design:
- Start from classic layered pattern
- Layers:
  - Timer Layer
    - Responsible for triggering the payment process once a month.
  - Business Logic Layer
    - Responsible for processing the payment logic.
  - Data Access Layer
    - Responsible for interacting with the database to retrieve salary data.
  - Data Store Layer
    - Represents the SQL Server database where salary records are stored.

Redundancy & Scalability
- Redundancy
  - Deploy 2 instances of the Payment Interface Service.
  - Use Active-Active configuration.
  - Use Is-Alive mechanism to monitor instances and switch traffic if one instance fails to avoid duplicate payment files.
- Scalability
  - Not applicable - the service runs once a month and does not require scaling.

### Queue Technology Stack
- Options:
  - Self Developed Queue System - NO GO - reinventing the wheel
  - RabitMQ
  - Kafka

| Alternative | Description                           | Pros                                                                                      | Cons                                              | Suitable for Dunderly?                      |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| RabitMQ     | General purpose message-broker engine | - Easy to setup and use<br>- Good documentation<br>- Supports multiple messaging patterns | - Not designed for high-throughput scenarios      | YES - suitable for low to medium throughput |
| Kafka       | Distributed event streaming platform  | - High throughput<br>- Scalable<br>- Durable message storage                              | - More complex setup<br>- Requires more resources | NO GO - overkill for Dunderly's needs       |

![Diagram](./diagrams/components-n-messaging-system%20-%20logic%20diagram.png)
![Diagram](./diagrams/components-n-messaging-system%20-%20physical%20diagram.png)
![Diagram](./diagrams/components-n-messaging-system%20-%20technical%20diagram.png)
