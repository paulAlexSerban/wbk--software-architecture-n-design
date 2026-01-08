# Dunderly - Your Paper Source
> FROM: "Software Architecture Case Studies" on Udemy

## Overview
Dunderly is a growing business that sells paper supplies (printer paper, envelopes, notepads) and office supplies (pens, staplers, organizers). As the business expands, a comprehensive HR system is required to manage employee records, payroll, vacations, and benefits efficiently.

**Business Context:**
- Company size: Currently 250 employees, expected to grow to 500 employees in 5 years
- Current state: Manual HR processes, no centralized system
- Goal: Implement a web-based HR management system to streamline operations

## Requirements

### Functional Requirements (What the system should do)
- **Web-based interface**: Accessible from any browser, no desktop installation required
- **Employee Management**: Perform CRUD (Create, Read, Update, Delete) operations on employee records
- **Salary Management**:
  - Allow managers to request salary changes for their team members
  - Allow HR managers to approve or reject salary change requests
  - Maintain salary history and audit trail
- **Vacation Management**:
  - Track available vacation days per employee
  - Allow employees to request vacation time
  - Allow HR to set and adjust vacation day allocations
- **Payroll Integration**: 
  - Interface with external payment system to process monthly payroll
  - Generate payment files in CSV format for legacy system integration
- **Reporting**: Generate management reports for HR analytics and decision-making

### Non-Functional Requirements (What the system should deal with)

**Performance Requirements:**
- Concurrent Users: Support ~10 simultaneous users
- Response Time: Maximum 2 seconds for any user action
- Employee Capacity: Manage 250 employees initially, scale to 500 employees

**Data Volume Estimation:**
- 1 employee record: ~1 MB (structured data)
- Average 10 scanned documents per employee
- 1 scanned document: ~5 MB
- Total storage per employee: ~51 MB (1 MB + 10 × 5 MB)
- Total storage for 500 employees: ~25 GB
- Data type: Mix of relational (employee records) and unstructured (document scans)
- Growth rate: Low, predictable growth over 5 years

**Service Level Agreement (SLA):**
- System Criticality: Important but not mission-critical for daily operations
- Maximum Downtime: 4 hours per month
- Backup Frequency: Daily backups required
- Recovery Time Objective (RTO): Maximum 4 hours
- Recovery Point Objective (RPO): Maximum 1 hour data loss acceptable

**Integration Requirements:**
- Legacy Payment System:
  - Technology: C++ application hosted on company servers
  - Integration Method: File-based (CSV), no API or database connection
  - Frequency: Monthly batch processing
  - One-way communication: HR system → Payment system

**Infrastructure Constraints:**
- Technology Stack: Microsoft ecosystem (.NET, SQL Server)
- Hosting: On-premise deployment preferred
- Existing Infrastructure: SQL Server database already in use

## Executive Summary

The Dunderly HR Management System is a web-based application designed to streamline employee record management, salary administration, vacation tracking, and payroll processing. The system follows a microservices-oriented architecture with the following key characteristics:

**Architecture Style:** Service-Oriented Architecture (SOA) with distinct services for each business domain

**Key Components:**
- **View Service**: Serves static web content to end users
- **Employees Service**: Manages employee records and documents
- **Salary Service**: Handles salary change requests and approval workflows
- **Vacation Service**: Manages vacation day allocations and tracking
- **Payment Interface**: Integrates with legacy payment system via CSV files
- **Logging & Monitoring Service**: Centralized logging for all system components

**Technology Stack:**
- Backend: .NET Web API and Services
- Database: SQL Server (relational data + BLOB storage for documents)
- Message Queue: RabbitMQ for asynchronous communication
- Load Balancing: For redundancy and availability

**Architecture Principles:**
- Separation of concerns: Each service handles a distinct business domain
- Shared data store: Single SQL Server database for data consistency
- Asynchronous communication: RabbitMQ messaging for inter-service communication
- Redundancy: Active-Active deployment for critical services
- Scalability: Horizontal scaling behind load balancers

![System Architecture - Logic Diagram](./diagrams/components-n-messaging-system%20-%20logic%20diagram.png)

## Components

Based on [the requirements](#requirements), the following components comprise the HR system architecture:

### 1. View Service
**Purpose**: Serves the web-based user interface to end users
**Responsibilities:**
- Receive HTTP requests from user browsers
- Return static files (HTML, CSS, JavaScript)
- Act as the entry point for all user interactions

### 2. Employees Service
**Purpose**: Manages all employee-related data and operations
**Responsibilities:**
- CRUD operations on employee records
- Employee document management (upload, storage, retrieval)
- Document lifecycle management (contracts, certificates, etc.)
- Employee status management (active/inactive)

### 3. Salary Service
**Purpose**: Handles salary change workflows and approvals
**Responsibilities:**
- Process salary change requests from managers
- Implement approval workflow for HR managers
- Maintain salary history and audit trail
- Validate salary change requests

### 4. Vacation Service
**Purpose**: Manages employee vacation day allocations and usage
**Responsibilities:**
- Track available vacation days per employee
- Process vacation day reductions
- Allow HR to set/adjust vacation allocations
- Maintain vacation history

### 5. Payment Interface
**Purpose**: Bridge between HR system and legacy payment system
**Responsibilities:**
- Monthly batch job to extract salary data
- Generate CSV files in required format
- Deliver files to payment system
- Error handling and retry logic

### 6. Logging & Monitoring Service
**Purpose**: Centralized logging and monitoring for all system components
**Responsibilities:**
- Collect log records from all services via message queue
- Store logs in persistent storage
- Provide log analysis capabilities
- Support system monitoring and alerting

### 7. Message Queue System (RabbitMQ)
**Purpose**: Enable asynchronous communication between services
**Responsibilities:**
- Decouple service communications
- Ensure reliable message delivery
- Support publish-subscribe patterns
- Buffer messages during high load or service unavailability

### 8. Data Store (SQL Server)
**Purpose**: Centralized data persistence for all services
**Responsibilities:**
- Store relational data (employee records, salaries, vacations)
- Store unstructured data (documents using BLOB storage)
- Provide transactional consistency
- Support backup and recovery requirements

**Design Decision - Shared vs. Per-Service Data Store:**
- **Decision**: Single shared data store
- **Rationale**: Data is highly interconnected across services (employees, salaries, vacations), requiring transactional consistency and simplified data management
- **Trade-off**: Reduced service autonomy, but appropriate given low scale and data consistency requirements

### Messaging System

**Selected Technology: RabbitMQ**

**Purpose**: Enable asynchronous, reliable communication between services, particularly for logging and event-driven workflows.

**Use Cases:**
- Logging: All services publish log messages to RabbitMQ, consumed by the Logging & Monitoring Service
- Event notifications: Services can publish events (e.g., employee created, salary approved) for other services to consume
- Decoupling: Services can communicate without direct dependencies

**Architecture Pattern:**
- Publish-Subscribe model for logging
- Direct exchanges for point-to-point communication
- Durable queues for message persistence

**Technology Selection Rationale:**

| Technology        | Pros                                                                              | Cons                                         | Decision          |
| ----------------- | --------------------------------------------------------------------------------- | -------------------------------------------- | ----------------- |
| RabbitMQ          | - Easy setup and configuration<br>- Excellent documentation<br>- Multiple messaging patterns<br>- Suitable for low-medium throughput | - Not designed for high-throughput scenarios | ✅ **Selected**   |
| Apache Kafka      | - High throughput<br>- Highly scalable<br>- Durable message storage               | - Complex setup<br>- Requires more resources<br>- Overkill for Dunderly's scale | ❌ Not suitable  |
| Self-Developed    | - Full control                                                                    | - Reinventing the wheel<br>- Maintenance burden<br>- Lack of proven reliability | ❌ Not suitable  |

**Deployment:**
- Single RabbitMQ instance sufficient for current scale
- Future scaling: Can add clustering if throughput increases

### Scaling

**Current Scale Requirements:**
- 10 concurrent users
- 250-500 employees
- Low data volume (~25 GB)
- Non-mission-critical system

**Scaling Strategy:**

**Horizontal Scaling:**
- View Service: Deploy behind load balancer, add instances as needed
- Employees Service: Deploy behind load balancer, add instances as needed
- Salary Service: Deploy behind load balancer, add instances as needed
- Vacation Service: Deploy behind load balancer, add instances as needed

**Vertical Scaling:**
- SQL Server: Upgrade hardware if database performance becomes bottleneck
- RabbitMQ: Current single-instance sufficient; clustering available if needed

**Bottleneck Analysis:**
- Database likely bottleneck before application services
- Document storage may require scaling if document volume increases significantly
- Payment Interface runs monthly, no scaling concerns

**Monitoring and Triggers:**
- Monitor CPU, memory, and response times
- Set alerts at 70% capacity thresholds
- Scale proactively before user experience degrades

**Future Considerations:**
- If employee count exceeds 1000, consider database sharding by department
- If document volume exceeds 100 GB, consider separate object storage
- If concurrent users exceed 50, reassess load balancer capacity

## Services Drill Down

This section provides detailed architecture and design specifications for each service component in the system.

### Logging & Monitoring Service

**Purpose**: Centralized logging infrastructure for all system components

**Architecture Decision Process:**

**1. Build vs. Buy Decision:**
- **Question**: Is there an existing logging mechanism in the company?
  - **Answer**: No, systems are currently siloed with no shared logging
- **Question**: Should we develop custom or use existing solution?
  - **Answer**: Design custom solution tailored to needs (vs. over-engineered solutions like ELK Stack)

**2. Application Type:**
- **What it does**:
  - Read log records from message queue
  - Validate and process log records
  - Store logs in persistent storage (SQL Server)
  - Support log analysis and alerting
- **Type Decision**: Service (background process)
  - ✅ Service: Suitable for production, runs continuously, no UI
  - ❌ Console Application: Not suitable for production systems

**3. Technology Stack:**
- **Programming Language**: .NET Service
  - **Rationale**: Consistent with company's Microsoft stack
  - **Capabilities**: Queue API access, validation logic, database operations
- **Data Store**: SQL Server
  - ✅ Relational Database: Suitable for structured log records
  - ❌ NoSQL Database: Not necessary for structured logs

**4. Architecture Design:**

Based on Classic Layered Pattern, adapted for long-running background service:

**Layers:**
1. **Polling Layer**
   - Continuously monitors RabbitMQ for new log messages
   - Implements polling mechanism with configurable intervals
   - Handles connection management and retry logic

2. **Business Logic Layer**
   - Validates log record format and content
   - Performs data transformations as needed
   - Implements filtering and categorization logic
   - Triggers alerts for critical errors

3. **Data Access Layer**
   - Manages database connections and transactions
   - Executes SQL operations to persist log records
   - Handles database exceptions and retries

4. **Data Store Layer**
   - SQL Server database with optimized log schema
   - Indexes for efficient querying by timestamp, service, severity
   - Retention policies for log archival

**5. Redundancy & Scalability:**

**Redundancy:**
- Deploy 2 instances in Active-Active configuration
- Implement Is-Alive mechanism to prevent duplicate processing
- Each instance monitors queue but coordinates to avoid duplicate log entries
- Load distributed via RabbitMQ consumer acknowledgments

**Scalability:**
- Queue-based architecture decouples log producers from consumers
- Add more service instances if queue depth increases
- Database indexing ensures query performance as log volume grows

![Logging Service Architecture](./diagrams/logging-service.png)

#### Logging - Alternative Solutions

**ELK Stack (Elasticsearch, Logstash, Kibana)**

**Decision**: ❌ Not suitable for Dunderly

| Aspect | Analysis |
|--------|----------|
| **Pros** | - Powerful search and analytics (Elasticsearch)<br>- Import logs from many sources (Logstash)<br>- Excellent visualization and filtering (Kibana)<br>- Scalable and flexible architecture<br>- Open-source with large community |
| **Cons** | - Complex installation and setup<br>- Requires significant maintenance effort<br>- Resource-intensive (CPU, memory, storage)<br>- Overkill for low-volume logging (~10 users, 500 employees)<br>- Steep learning curve |
| **Verdict** | Not suitable: Complexity and resource requirements far exceed Dunderly's needs. Custom solution provides adequate functionality with lower overhead. |

**Alternative Consideration**: If logging requirements increase significantly (e.g., 1000+ employees, complex compliance requirements, advanced analytics needs), ELK Stack could be reconsidered.

### View Service

**Purpose**: Serves static web content to end-user browsers

**What it does:**
- Receives HTTP requests from user browsers
- Returns static files (HTML, CSS, JavaScript)
- Acts as entry point for the web application

**What it does NOT do:**
- No business logic processing
- No direct database access
- No data transformation

**Application Type**: Web Application

**Technology Stack:**
- **Framework**: .NET Web API / ASP.NET Core
- **Rationale**: 
  - Excellent support for static file serving
  - Consistent with company's Microsoft stack
  - Built-in HTTP request handling
  - Lightweight for static content delivery

**Architecture Design:**

**Pattern**: Simplified 3-Layer Pattern (UI Layer only)

Since this service serves only static files, most traditional layers are unnecessary:

**Layer:**
1. **User Interface Layer**
   - HTTP request handling
   - Static file routing
   - Content type management (HTML, CSS, JS, images)
   - Caching headers for performance

**Redundancy & Scalability:**
- Deploy 2+ instances behind a load balancer
- Load balancer performs health checks
- Session-less design enables easy scaling
- CDN can be added in future for static asset caching

**Performance Considerations:**
- Enable gzip compression for text files
- Set appropriate cache headers
- Minify CSS and JavaScript in production
- Serve assets with far-future expiry dates

### Employees Service

**Purpose**: Manages all employee-related data and operations, including employee records and document management

**What it does:**
- Query employee records by various criteria
- Perform CRUD operations on employee records
- Manage employee documents (contracts, certificates, etc.)
- Maintain employee status (active/inactive)

**What it does NOT do:**
- Display data to end users (View Service responsibility)
- Process salary information (Salary Service responsibility)
- Manage vacation days (Vacation Service responsibility)

**Application Type**: Web API (RESTful)

**Technology Stack:**

**Framework**: .NET Web API
- **Rationale**: 
  - Consistent with company's Microsoft stack
  - Robust HTTP request handling
  - Built-in serialization and validation
  - Excellent Entity Framework integration

**Database Technology Decision:**

The service must handle two data types:
1. **Relational Data**: Employee records (structured)
2. **Unstructured Data**: Employee documents (scanned PDFs, images)

**Document (BLOB) Storage Alternatives:**

| Alternative         | Description                                                | Examples                    | Pros                                                                      | Cons                                                                          | Decision for Dunderly           |
| ------------------- | ---------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------- |
| Relational Database | Store documents in BLOB column type                        | SQL Server FILESTREAM       | - Part of app transaction<br>- Included in DB backup/DR<br>- ACID guarantees | - Clunky syntax<br>- Size limitations<br>- Can bloat database                 | ✅ **Selected** (suitable for small volume) |
| File System         | Store files on file system, hold pointer in DB             | NFS, SMB, Local FS          | - Simple implementation<br>- Easy file access                              | - Separate backup/DR<br>- Scalability issues<br>- Not transactional            | ❌ Backup/DR complexity         |
| Object Store        | Specialized BLOB storage mechanism                         | MinIO, Ceph, OpenStack      | - Highly scalable<br>- Designed for large files                            | - Additional component<br>- Separate backup/DR<br>- Complex setup              | ❌ Adds unnecessary complexity  |
| Cloud Storage       | Public cloud storage services                              | AWS S3, Azure Blob, GCS     | - Highly scalable<br>- Managed service<br>- High availability              | - Cloud provider dependency<br>- Ongoing costs<br>- Internet required<br>- Not on-premise | ❌ Not suitable for on-premise |

**Selected Solution**: SQL Server with BLOB storage
- Appropriate for 25 GB data volume
- Transactional consistency with employee records
- Simplified backup/recovery (single system)
- Leverages existing SQL Server infrastructure

**Architecture Design:**

**Pattern**: Classic 3-Layer Architecture

**Layers:**
1. **Service Interface Layer (API Layer)**
   - Handles HTTP requests and responses
   - Input validation and sanitization
   - Authentication and authorization
   - Returns appropriate HTTP status codes

2. **Business Logic Layer**
   - Employee record validation rules
   - Business logic for employee lifecycle
   - Document validation (file type, size limits)
   - Soft delete implementation

3. **Data Access Layer**
   - Entity Framework for relational data
   - BLOB API for document storage
   - Transaction management
   - Database connection pooling

4. **Data Store Layer**
   - SQL Server database
   - Employee records table with indexes
   - Document metadata table
   - BLOB storage for document files

**API Design:**

**Design Principles:**
- RESTful conventions
- Resource-based URLs
- Appropriate HTTP methods (GET, POST, PUT, DELETE)
- Meaningful HTTP status codes
- Versioned API (/api/v1/)

**Should Documents be a Separate Service?**
- **Decision**: No, keep within Employees Service
- **Rationale**: Document lifecycle is tightly coupled to employee records
- **Future Consideration**: Extract to separate service if other services need document storage

**Endpoints:**

| Functionality                | HTTP Method | Endpoint                                 | Return Codes  | Description                                      |
| ---------------------------- | ----------- | ---------------------------------------- | ------------- | ------------------------------------------------ |
| Get employee details by ID   | GET         | `/api/v1/employee/{id}`                  | 200, 404      | Retrieve full details of an employee by their ID |
| List employees by params     | GET         | `/api/v1/employee?name=...&department=...` | 200, 400      | Retrieve a list of employees based on parameters |
| Add employee                 | POST        | `/api/v1/employee`                       | 201, 400      | Create a new employee record                     |
| Update employee details      | PUT         | `/api/v1/employee/{id}`                  | 200, 400, 404 | Update details of an existing employee           |
| Remove employee              | DELETE      | `/api/v1/employee/{id}`                  | 200, 404      | Soft delete - mark employee as inactive          |
| Add employee document        | POST        | `/api/v1/employee/{id}/documents`        | 201, 400, 404 | Upload a document for an employee                |
| Remove employee document     | DELETE      | `/api/v1/employee/{id}/documents/{docId}` | 200, 404      | Soft delete - mark document as inactive          |
| Get employee document by ID  | GET         | `/api/v1/employee/{id}/documents/{docId}` | 200, 404      | Download a specific document                     |
| Retrieve documents by params | GET         | `/api/v1/employee/{id}/documents?type=...` | 200, 400      | List documents with filtering                    |

**Response Codes Explained:**
- **200 OK**: Successful operation
- **201 Created**: Resource successfully created
- **400 Bad Request**: Invalid input data
- **404 Not Found**: Resource does not exist

**Redundancy & Scalability:**
- Deploy 2+ instances behind load balancer
- Stateless design enables horizontal scaling
- Database connection pooling for efficiency
- Read replicas can be added if query load increases

### Salary Service

**Purpose**: Manages salary change workflow and approval process

**What it does:**
- Accept salary change requests from managers
- Implement approval workflow for HR managers
- Maintain salary change history and audit trail
- Validate salary change requests against business rules

**What it does NOT do:**
- Direct salary modifications (requires approval workflow)
- Employee record management (Employees Service responsibility)
- Payment processing (Payment Interface responsibility)

**Application Type**: Web API (RESTful)

**Technology Stack:**
- **Framework**: .NET Web API
- **Rationale**: 
  - Consistent with Microsoft stack
  - Supports workflow orchestration
  - Transaction management for approvals

**Architecture Design:**

**Pattern**: Classic 3-Layer Architecture

**Layers:**
1. **Service Interface Layer (API Layer)**
   - Handles HTTP requests for salary operations
   - Request validation and authorization
   - Workflow state management
   - Response formatting

2. **Business Logic Layer**
   - Salary change validation rules
   - Approval workflow logic
   - Business rule enforcement (e.g., max increase %, approval thresholds)
   - Notification triggering

3. **Data Access Layer**
   - Salary request CRUD operations
   - Approval history tracking
   - Transaction management for state changes

4. **Data Store Layer**
   - SQL Server database
   - Salary request table with status tracking
   - Approval history table for audit trail

**API Design:**

**REST Design Note**: Why use nouns ("approval", "rejection") instead of verbs ("approve", "reject")?
- REST deals with resources (nouns), not actions (verbs)
- The HTTP method (POST) indicates the action
- Endpoints represent resource state transitions

**Endpoints:**

| Functionality          | HTTP Method | Endpoint                                     | Return Codes  | Description                               |
| ---------------------- | ----------- | -------------------------------------------- | ------------- | ----------------------------------------- |
| Add salary request     | POST        | `/api/v1/salary/request`                     | 201, 400      | Create a new salary change request        |
| Remove salary request  | DELETE      | `/api/v1/salary/request/{requestId}`         | 200, 404      | Delete a salary change request            |
| Get salary requests    | GET         | `/api/v1/salary/requests?status=...&employeeId=...` | 200, 400      | Retrieve salary change requests with filters |
| Get salary request by ID | GET       | `/api/v1/salary/request/{requestId}`         | 200, 404      | Retrieve specific salary request details  |
| Approve salary request | POST        | `/api/v1/salary/request/{requestId}/approval` | 200, 400, 404 | Approve a salary change request           |
| Reject salary request  | POST        | `/api/v1/salary/request/{requestId}/rejection` | 200, 400, 404 | Reject a salary change request            |

**Request Flow:**
1. Manager creates salary request (POST to `/salary/request`)
2. Request enters "Pending" state
3. HR Manager reviews request (GET `/salary/requests?status=pending`)
4. HR Manager approves or rejects (POST to `/approval` or `/rejection`)
5. Request state changes to "Approved" or "Rejected"
6. Approved requests flow to Payment Interface for processing

**Redundancy & Scalability:**
- Deploy 2+ instances behind load balancer
- Stateless API design for easy scaling
- Database transactions ensure consistency
- Queue notifications for approved salaries

### Vacation Service

**Purpose**: Manages employee vacation day allocations and usage

**What it does:**
- Allow employees to view and reduce their vacation days
- Allow HR to set and adjust vacation day allocations
- Track vacation day balances per employee
- Maintain vacation history for audit purposes

**What it does NOT do:**
- Vacation request approval workflow (simplified model: direct reduction)
- Calendar management or vacation scheduling
- Team vacation coordination

**Application Type**: Web API (RESTful)

**Technology Stack:**
- **Framework**: .NET Web API
- **Rationale**: 
  - Consistent with Microsoft stack
  - Simple CRUD operations
  - Transaction support for balance updates

**Architecture Design:**

**Pattern**: Classic 3-Layer Architecture

**Layers:**
1. **Service Interface Layer (API Layer)**
   - Handles HTTP requests for vacation operations
   - Input validation (ensure positive values, sufficient balance)
   - Authorization checks (HR vs. employee permissions)
   - Response formatting

2. **Business Logic Layer**
   - Vacation balance validation
   - Insufficient balance checks
   - Business rules (e.g., minimum/maximum vacation days)
   - Calculation logic for reductions

3. **Data Access Layer**
   - Vacation balance CRUD operations
   - Transaction management for balance updates
   - History logging for audit trail

4. **Data Store Layer**
   - SQL Server database
   - Vacation balance table (employee_id, available_days)
   - Vacation history table for tracking changes
**API Design:**

**Endpoints:**

| Functionality               | HTTP Method | Endpoint                                | Return Codes  | Description                                 |
| --------------------------- | ----------- | --------------------------------------- | ------------- | ------------------------------------------- |
| Set available vacation days | PUT         | `/api/v1/vacation/{employeeId}`         | 200, 400, 404 | Set/update vacation day balance (HR only)   |
| Get available vacation days | GET         | `/api/v1/vacation/{employeeId}`         | 200, 404      | Retrieve current vacation day balance       |
| Get vacation history        | GET         | `/api/v1/vacation/{employeeId}/history` | 200, 404      | Retrieve vacation usage history             |
| Reduce vacation days        | POST        | `/api/v1/vacation/{employeeId}/reduction` | 200, 400, 404 | Reduce vacation days (record usage)         |

**API Usage Examples:**
- HR sets initial balance: `PUT /api/v1/vacation/123` with body `{"days": 20}`
- Employee checks balance: `GET /api/v1/vacation/123` returns `{"employeeId": 123, "availableDays": 20}`
- Employee takes vacation: `POST /api/v1/vacation/123/reduction` with body `{"days": 5, "reason": "Annual vacation"}`
- Updated balance: `GET /api/v1/vacation/123` returns `{"employeeId": 123, "availableDays": 15}`

**Business Rules:**
- Cannot reduce more days than available balance (return 400 Bad Request)
- Only HR can set/increase vacation days
- Employees can only reduce their own vacation days
- All reductions logged in history table

**Redundancy & Scalability:**
- Deploy 2+ instances behind load balancer
- Stateless design for horizontal scaling
- Database transactions prevent race conditions
- Read-heavy workload suitable for read replicas if needed

### Payment Interface

**Purpose**: Bridge between HR system and legacy payment system

**What it does:**
- Run monthly batch job to extract salary data
- Query approved salary changes from database
- Generate CSV files in format required by payment system
- Deliver files to payment system's designated location
- Handle errors and implement retry logic
- Log processing status for audit

**What it does NOT do:**
- Approve salary changes (Salary Service responsibility)
- Modify employee records (Employees Service responsibility)
- Real-time processing (batch-only, monthly schedule)

**Application Type**: Background Service (scheduled task)

**Characteristics:**
- Long-running process
- No user interface
- No API exposed to external systems
- Scheduled execution (monthly)

**Technology Stack:**
- **Framework**: .NET Windows Service / Worker Service
- **Rationale**: 
  - Consistent with Microsoft stack
  - Supports scheduled task execution
  - Reliable background processing
  - Built-in service lifecycle management

**Architecture Design:**

**Pattern**: Modified Layered Architecture (for batch processing)

**Layers:**
1. **Timer/Scheduler Layer**
   - Triggers job execution on monthly schedule (e.g., 1st day of month)
   - Handles scheduling logic and timing
   - Supports manual trigger for ad-hoc runs

2. **Business Logic Layer**
   - Query database for approved salary changes
   - Aggregate salary data for payroll period
   - Generate CSV file according to payment system specifications
   - Validate data completeness and correctness
   - Implement retry logic for failures

3. **Data Access Layer**
   - Query SQL Server for salary data
   - Retrieve employee information for payroll
   - Mark processed records to avoid duplication
   - Log processing status

4. **File Output Layer**
   - Write CSV file to designated location
   - Handle file system errors
   - Implement file naming convention (e.g., `payroll_YYYY_MM.csv`)

5. **Data Store Layer**
   - SQL Server database (shared with other services)
   - Access salary and employee tables

**Integration with Legacy System:**
- **Method**: File-based integration
- **Format**: CSV files
- **Location**: Shared file system or FTP location
- **Frequency**: Once per month
- **Direction**: One-way (HR system → Payment system)

**CSV File Specification (example):**
```
EmployeeId,FirstName,LastName,Salary,EffectiveDate
001,John,Doe,75000.00,2026-02-01
002,Jane,Smith,82000.00,2026-02-01
```

**Redundancy & Scalability:**

**Redundancy:**
- Deploy 2 instances with Active-Active configuration
- Implement "Is-Alive" mechanism and distributed locking
- Only one instance processes at a time to avoid duplicate files
- If active instance fails, standby instance takes over

**Scalability:**
- Not applicable: Monthly batch, low processing requirements
- Current design sufficient for 500+ employees
- Processing time: Estimated <5 minutes for 500 records

**Error Handling:**
- Retry failed queries (transient database errors)
- Alert on file write failures
- Log all operations for audit trail
- Generate error reports for manual review

### Queue Technology Stack

**Purpose**: Enable asynchronous, reliable messaging between system components

**Technology Evaluation:**

| Alternative | Description                           | Pros                                                                                      | Cons                                              | Decision for Dunderly                       |
| ----------- | ------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| **RabbitMQ** | General-purpose message broker        | - Easy setup and configuration<br>- Excellent documentation and community<br>- Supports multiple messaging patterns<br>- Low resource requirements<br>- Suitable for low-medium throughput | - Not designed for high-throughput scenarios<br>- Limited built-in analytics | ✅ **Selected** - Perfect fit for requirements |
| **Apache Kafka** | Distributed event streaming platform  | - High throughput (millions of messages/sec)<br>- Horizontally scalable<br>- Durable message storage<br>- Built-in stream processing | - Complex setup and configuration<br>- Requires more resources (RAM, disk)<br>- Steeper learning curve<br>- Overkill for low message volume | ❌ Not suitable - Unnecessary complexity |
| **Self-Developed** | Custom queue implementation       | - Full control over features<br>- No external dependencies | - Reinventing the wheel<br>- High maintenance burden<br>- Lack of proven reliability<br>- Missing enterprise features | ❌ Not suitable - Poor use of resources |

**Selected Solution: RabbitMQ**

**Rationale:**
- Low message volume (~10 users, 500 employees)
- Simple use cases (logging, event notifications)
- Ease of setup aligns with small operations team
- Proven reliability in similar environments
- Adequate performance for current and future scale

**Usage Patterns:**
1. **Logging**: All services publish log messages to dedicated exchange/queue
2. **Event Notifications**: Services publish domain events (e.g., EmployeeCreated, SalaryApproved)
3. **Asynchronous Processing**: Decouple time-consuming operations from user requests

**Configuration:**
- Single RabbitMQ instance sufficient initially
- Can add clustering for high availability if needed
- Persistent queues for critical messages (logging)
- Durable exchanges for reliability

## Architecture Diagrams

### Logic Diagram
Illustrates the high-level components and their logical relationships.

![Components & Messaging System - Logic Diagram](./diagrams/components-n-messaging-system%20-%20logic%20diagram.png)

### Physical Diagram
Shows the deployment topology and infrastructure layout.

![Components & Messaging System - Physical Diagram](./diagrams/components-n-messaging-system%20-%20physical%20diagram.png)

### Technical Diagram
Details the technology stack and communication protocols.

![Components & Messaging System - Technical Diagram](./diagrams/components-n-messaging-system%20-%20technical%20diagram.png)

## Security Considerations

**Authentication & Authorization:**
- Implement role-based access control (RBAC)
- User roles: Employee, Manager, HR Manager, System Admin
- JWT tokens for API authentication
- Session management for web interface

**Data Protection:**
- Encrypt sensitive data at rest (salaries, personal information)
- Use HTTPS/TLS for all communications
- Secure file transfer for payment system integration
- Regular security audits and penetration testing

**Audit Logging:**
- Log all data modifications (who, what, when)
- Maintain immutable audit trail
- Separate audit logs from application logs
- Retention policy: 7 years for compliance

## Backup and Disaster Recovery

**Backup Strategy:**
- Daily full backups of SQL Server database
- Transaction log backups every hour (RPO: 1 hour)
- Document storage included in database backups
- Offsite backup storage for disaster recovery

**Recovery Procedures:**
- Recovery Time Objective (RTO): 4 hours
- Recovery Point Objective (RPO): 1 hour
- Documented recovery procedures
- Regular recovery testing (quarterly)

**High Availability:**
- Active-Active deployment for services
- Load balancer health checks
- Automatic failover for critical components
- Monitoring and alerting for all services

## Monitoring and Observability

**Key Metrics:**
- Application response times
- Error rates and exceptions
- Database query performance
- Queue depth and processing lag
- Service availability (uptime)

**Alerting:**
- Critical: Service down, database unavailable
- Warning: High response times, elevated error rates
- Info: Successful batch job completion, backup completion

**Logging Levels:**
- ERROR: Application errors requiring immediate attention
- WARNING: Potential issues or unusual conditions
- INFO: Significant application events (logins, approvals)
- DEBUG: Detailed troubleshooting information (non-production)

## Future Enhancements

**Potential Improvements:**
1. **Mobile Application**: Native iOS/Android apps for on-the-go access
2. **Advanced Reporting**: Business intelligence dashboard with analytics
3. **Performance Reviews**: Integrate performance management workflow
4. **Time Tracking**: Add attendance and time-off tracking
5. **Benefits Management**: Expand to include health insurance, retirement plans
6. **API for Payment System**: Replace file-based integration with REST API
7. **Single Sign-On (SSO)**: Integrate with corporate identity provider
8. **Document OCR**: Automatic data extraction from scanned documents

**Scalability Roadmap:**
- Current: 500 employees, 10 concurrent users
- Phase 2 (1-2 years): 1000 employees, 25 concurrent users
- Phase 3 (3-5 years): 2000+ employees, 50+ concurrent users, multi-location support

## Conclusion

The Dunderly HR Management System architecture provides a robust, scalable solution for managing employee records, salaries, vacations, and payroll. The service-oriented design with shared data store balances simplicity with functionality, appropriate for the company's current scale and expected growth.

**Key Strengths:**
- Aligned with existing technology stack (Microsoft/.NET)
- Appropriate scale for current and projected needs
- Clear separation of concerns across services
- Proven technology choices with minimal risk
- Straightforward deployment and maintenance

**Success Metrics:**
- System availability: >99% uptime (max 4 hours downtime/month)
- Response time: <2 seconds for all user actions
- Successful monthly payroll processing: 100%
- User satisfaction: Measured through periodic surveys
