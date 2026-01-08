# PayRawl - Payment Processing Pipeline
> FROM: "Software Architecture Case Studies" on Udemy

## Overview

PayRawl is an automated payment processing system designed to handle payment files from various sources, validate and process them through multiple stages, and generate bank-ready instruction files for payment execution. The system operates completely autonomously without requiring any user interface or manual intervention.

**Business Context:**
- Industry: Financial technology / Payment processing
- Business Model: B2B payment processing service provider
- Current State: Manual file processing with multiple formats and validation requirements
- Goal: Fully automated, scalable, fault-tolerant payment processing pipeline
- Target Users: None (fully automated system with no UI)

**System Characteristics:**
- **Automated Operation**: Runs continuously without human intervention
- **File-Based Integration**: Receives input via file system, outputs to designated bank folders
- **Format Agnostic**: Supports multiple payment file formats through pluggable formatters
- **Mission-Critical**: Zero tolerance for data loss; all transactions must be processed reliably
- **Audit Compliant**: Maintains complete activity logs for 7 years for regulatory compliance

## Requirements

### Functional Requirements (What the system should do)

- **File Ingestion**: Automatically retrieve payment files from designated source folders
- **Format Support**: Handle multiple payment file formats through pluggable formatters
- **File Validation**: Validate incoming files for format correctness and data integrity
- **Data Processing**: Perform business rule calculations and transformations on payment data
- **Format Conversion**: Convert all input formats to a unified internal format for processing
- **Bank File Generation**: Create bank-specific payment instruction files
- **File Delivery**: Place processed payment files in designated bank folders
- **Audit Logging**: Maintain comprehensive logs of all processing activities
- **Log Retention**: Preserve activity logs for 7 years for regulatory compliance
- **Extensibility**: Support addition of new file formatters without system redesign
- **Error Handling**: Gracefully handle and log processing errors without data loss

### Non-Functional Requirements (What the system should deal with)

**Performance Requirements:**
- Processing Throughput: Handle 500 files per day
- Processing Time: Complete processing within 1 minute per file
- Average File Size: ~1 MB per payment file
- Peak Load: Support burst processing during business hours
- Queue Processing: Continuous processing with minimal latency

**Data Volume Estimation:**

**Payment Files:**
- 1 file: ~1 MB
- 500 files/day: ~500 MB/day
- 15,000 files/month: ~15 GB/month
- 180,000 files/year: ~180 GB/year
- 1,260,000 files/7 years: ~1.3 TB/7 years

**Activity Logs:**
- Assumption: Each file processing generates ~500 KB of logs
- Log entries per file: Multiple stages (ingestion, validation, formatting, calculation, export)
- 1 file: ~500 KB logs
- 500 files/day: ~250 MB/day logs
- 15,000 files/month: ~7.5 GB/month logs
- 180,000 files/year: ~95 GB/year logs
- 1,260,000 files/7 years: ~640 GB/7 years logs

**Total Storage Requirements:**
- Per year: ~275 GB (180 GB files + 95 GB logs)
- 7-year retention: ~2 TB total (1.3 TB files + 640 GB logs)

**Reliability Requirements:**
- **Data Loss Tolerance**: ZERO - Absolutely no data loss acceptable
- **Transaction Integrity**: All files must be processed exactly once (no duplicates, no skips)
- **Fault Recovery**: System must recover gracefully from failures without losing files
- **Message Durability**: Queue messages must persist through system restarts
- **Audit Completeness**: Every file operation must be logged

**Service Level Agreement (SLA):**
- System Availability: 99.9% uptime (≤ 8.76 hours downtime per year)
- Processing Success Rate: 99.99% (excluding invalid input files)
- Maximum Retry Attempts: 3 retries for transient failures
- Recovery Time Objective (RTO): < 15 minutes
- Recovery Point Objective (RPO): 0 minutes (no data loss)

**Integration Requirements:**
- **Input Integration**:
  - Method: File system monitoring (designated folders)
  - Frequency: Continuous monitoring with immediate processing
  - Format: Multiple payment file formats (extensible)
  - Direction: Inbound only

- **Output Integration**:
  - Method: File system write (designated bank folders)
  - Frequency: Immediate upon completion
  - Format: Bank-specific payment instruction files
  - Direction: Outbound only

**Infrastructure Constraints:**
- Technology Stack: Open to modern technologies (greenfield project)
- Hosting: On-premise or cloud-based
- Message Queue: Reliable queuing system with durability and fault tolerance
- Logging Platform: Centralized logging with search and analytics capabilities
- Scalability: Must support horizontal scaling for all components

## Executive Summary

PayRawl is a mission-critical, automated payment processing pipeline that transforms payment files from various formats into bank-ready instruction files. The system follows an **Event-Driven Architecture** with message queue-based communication, ensuring reliable, scalable, and fault-tolerant payment processing.

**Architecture Style:** Event-Driven Pipeline Architecture with Queue-Based Messaging

**Key Components:**
- **File Handler**: Monitors designated folders and ingests payment files into the processing pipeline
- **File Formatters**: Converts various payment file formats to unified internal format
- **File Calculation**: Applies business rules and performs necessary calculations
- **File Exporter**: Generates bank-specific payment instruction files and delivers to designated folders
- **Logging Service**: Centralized logging with Elastic Stack for audit trail and analytics
- **Message Queues**: RabbitMQ queues decouple components and ensure reliable message delivery

**Technology Stack:**
- Backend Services: .NET Core (all processing components)
- Message Queue: RabbitMQ (durable, persistent queuing)
- Logging Platform: Elastic Stack (Elasticsearch, Kibana, Logstash/Beats)
- Logging Library: Serilog with Elasticsearch sink
- File System: Standard file system monitoring for input/output

**Architecture Principles:**
- **Zero Data Loss**: Durable message queuing with transaction logging ensures no payment file is ever lost
- **Decoupled Components**: Message queues enable independent scaling and deployment of each processing stage
- **Horizontal Scalability**: Consumer group pattern allows multiple instances of each component for load distribution
- **Fault Tolerance**: "Is-Alive" mechanism for File Handler; consumer groups for processing components
- **Extensibility**: Pluggable formatter architecture supports adding new payment formats without system redesign
- **Observability**: Comprehensive logging at every stage with Elastic Stack for monitoring and troubleshooting

**Processing Pipeline Flow:**
```
Source Folders → File Handler → Files Queue → File Formatters → 
Formatted Files Queue → File Calculation → Calculated Files Queue → 
File Exporter → Bank Folders
                                    ↓
                          Elastic Stack (Logs)
```

**Key Architectural Decisions:**
1. **RabbitMQ over Kafka/SQS**: Chosen for ease of setup, reliability, and appropriateness for moderate throughput (not streaming data)
2. **.NET Core Technology Stack**: Selected for performance, cross-platform support, ease of use, and strong threading support
3. **Elastic Stack for Logging**: Provides enterprise-grade search, analytics, and visualization without custom development
4. **Queue-Based Decoupling**: Enables independent component evolution, scaling, and fault isolation
5. **Consumer Group Pattern**: Automatic load balancing across multiple service instances without custom load balancer

![System Architecture Diagram](./diagrams/components-n-messaging-system%20-%20technical%20diagram.png)

## Components

Based on [the requirements](#requirements), the following components comprise the PayRawl payment processing system:

### 1. File Handler
**Purpose**: Ingests payment files from designated folders and initiates the processing pipeline

**Responsibilities:**
- Monitor designated source folders for new payment files
- Retrieve files immediately upon detection
- Publish files to Files Queue for downstream processing
- Log ingestion events for audit trail
- Handle file system errors gracefully

**Interactions:**
- Receives data from: File system (source folders) - **OUT OF SCOPE**
- Sends data to: Files Queue (RabbitMQ)
- Dependencies: File system access, RabbitMQ client library

### 2. File Formatters
**Purpose**: Normalize various payment file formats to unified internal format

**Responsibilities:**
- Consume files from Files Queue
- Detect file format automatically or via metadata
- Apply appropriate formatter based on file format
- Convert to standardized internal format
- Validate format correctness and data integrity
- Publish formatted files to Formatted Files Queue
- Support pluggable formatters for extensibility

**Interactions:**
- Receives data from: Files Queue (RabbitMQ)
- Sends data to: Formatted Files Queue (RabbitMQ)
- Dependencies: Format-specific parsing libraries, RabbitMQ client

**Extensibility:**
- New formatters implement common interface
- Can add formatters without modifying core logic
- Each formatter handles specific input format

### 3. File Calculation
**Purpose**: Apply business rules and perform calculations on normalized payment data

**Responsibilities:**
- Consume formatted files from Formatted Files Queue
- Execute business rule calculations (fees, conversions, validations)
- Apply payment processing logic
- Enrich payment data with calculated fields
- Publish calculated files to Calculated Files Queue
- Log calculation operations and results

**Interactions:**
- Receives data from: Formatted Files Queue (RabbitMQ)
- Sends data to: Calculated Files Queue (RabbitMQ)
- Dependencies: Business rule engine, RabbitMQ client

### 4. File Exporter
**Purpose**: Generate bank-specific payment instruction files and deliver to destinations

**Responsibilities:**
- Consume calculated files from Calculated Files Queue
- Transform to bank-specific payment instruction format
- Generate compliant output files per bank specifications
- Write files to designated bank folders
- Log export operations and delivery status
- Handle file write errors with retry logic

**Interactions:**
- Receives data from: Calculated Files Queue (RabbitMQ)
- Sends data to: File system (bank folders) - **OUT OF SCOPE**
- Dependencies: Bank format specifications, file system access

### 5. Message Queue System (RabbitMQ)
**Purpose**: Enable reliable, asynchronous communication between pipeline stages

**Responsibilities:**
- Persist messages durably to prevent data loss
- Provide exactly-once delivery semantics
- Balance load across multiple consumer instances (consumer groups)
- Buffer messages during high load or downstream unavailability
- Support message acknowledgment for processing confirmation
- Enable decoupled, independent component scaling

**Queue Instances:**
- **Files Queue**: Between File Handler and File Formatters
- **Formatted Files Queue**: Between File Formatters and File Calculation
- **Calculated Files Queue**: Between File Calculation and File Exporter

**Key Features:**
- Durable queues with persistent messages
- Message acknowledgment to prevent loss
- Consumer groups for automatic load distribution
- Dead letter queues for failed message handling
- Monitoring and management UI

### 6. Logging Service (Elastic Stack)
**Purpose**: Centralized logging, monitoring, and analytics for entire pipeline

**Responsibilities:**
- Collect logs from all system components
- Index logs for fast search and retrieval
- Provide visualization and analytics dashboards
- Support 7-year log retention for compliance
- Enable troubleshooting and operational insights
- Generate alerts for error conditions

**Components:**
- **Elasticsearch**: Search and analytics engine for log storage
- **Kibana**: Visualization and dashboard platform
- **Logstash**: Log collection pipeline (for RabbitMQ logs)
- **Beats**: Lightweight log shippers (alternative to Logstash)
- **Serilog**: .NET logging library with Elasticsearch sink

**Log Sources:**
- All .NET Core services: Direct logging via Serilog → Elasticsearch
- RabbitMQ: Logs collected via Logstash → Elasticsearch

### 7. External Systems (Out of Scope)
**Source Folders**: File system locations where payment files are deposited
- Not part of PayRawl system
- Managed by upstream payment sources

**Bank Folders**: File system locations where bank instruction files are delivered
- Not part of PayRawl system
- Consumed by downstream banking systems

### Communication Patterns

**Asynchronous Communication (Primary):**
- File Handler → Files Queue → File Formatters
- File Formatters → Formatted Files Queue → File Calculation
- File Calculation → Calculated Files Queue → File Exporter
- All Components → Elasticsearch (logging)

**Synchronous Communication:**
- None - system is fully asynchronous and event-driven

**Why No REST APIs?**
- System is fully automated with no user interface
- No external API consumers
- Queue-based messaging provides necessary integration
- Simplifies architecture and reduces attack surface

## Scaling Strategy

**Current Scale Requirements:**
- 500 files per day (~21 files per hour, assuming 24/7 operation)
- 1 minute processing time per file
- Average file size: 1 MB
- Total daily data volume: ~500 MB
- Mission-critical: Zero data loss tolerance

**Scaling Strategy:**

### Horizontal Scaling (Primary Approach)

**File Formatters:**
- Deploy multiple instances using Consumer Group pattern
- RabbitMQ automatically distributes messages across instances
- Add instances during peak processing times
- Scale based on Files Queue depth

**File Calculation:**
- Deploy multiple instances using Consumer Group pattern
- Independent scaling from formatters
- Scale based on Formatted Files Queue depth
- Can allocate more resources if calculations are CPU-intensive

**File Exporter:**
- Deploy multiple instances using Consumer Group pattern
- Scale based on Calculated Files Queue depth
- Coordinate to prevent duplicate bank file writes

**Scaling Triggers:**
- Queue depth > 100 messages: Add instances
- Processing lag > 5 minutes: Add instances
- CPU utilization > 70% sustained: Add instances
- File Handler throughput insufficient: Add File Handler instances

### Vertical Scaling (Secondary Approach)

**File Handler:**
- Single active instance (Is-Alive pattern) with standby
- If file system I/O becomes bottleneck, upgrade disk subsystem
- Increase CPU if file watching overhead grows

**RabbitMQ:**
- Scale vertically before clustering
- Increase memory for larger message buffers
- Upgrade disk for faster persistence

**Elasticsearch:**
- Scale vertically for single-node deployment
- Add memory for larger index caches
- Upgrade storage for 7-year log retention

### Bottleneck Analysis

**Primary Bottlenecks:**
1. **File Formatters**: Complex parsing may be CPU-intensive
   - Mitigation: Horizontal scaling with consumer groups
2. **File Exporter**: File I/O to multiple bank folders
   - Mitigation: Batch writes, optimized I/O, multiple instances
3. **RabbitMQ**: Message throughput and persistence
   - Mitigation: Tune persistence settings, consider clustering for extreme scale

**Secondary Bottlenecks:**
- Elasticsearch: Log ingestion and indexing
  - Mitigation: Elasticsearch clustering, index optimization
- File System: Concurrent read/write operations
  - Mitigation: SSD storage, network file systems with high IOPS

### Load Distribution

**Consumer Group Pattern:**
- RabbitMQ automatically distributes messages to available consumers
- Built-in load balancing without external load balancer
- Consumers acknowledge message processing for exactly-once semantics
- Failed messages re-queued or sent to dead letter queue

**Current Capacity:**
- Single instance of each component can handle: ~100 files/day
- 5 instances of each component can handle: ~500 files/day
- Provides 5x headroom for growth or burst traffic

### Future Scaling Milestones

**Current** (500 files/day):
- Baseline: 1-2 instances of File Formatters, Calculation, Exporter
- File Handler: 1 active + 1 standby
- RabbitMQ: Single node, durable queues
- Elasticsearch: Single node with sufficient storage

**Phase 2** (2,000 files/day - 4x growth):
- File Formatters: 5-8 instances
- File Calculation: 5-8 instances
- File Exporter: 5-8 instances
- RabbitMQ: Consider clustering for high availability
- Elasticsearch: 3-node cluster for resilience

**Phase 3** (10,000 files/day - 20x growth):
- File Formatters: 20-30 instances
- File Calculation: 20-30 instances
- File Exporter: 20-30 instances
- RabbitMQ: Multi-node cluster with mirrored queues
- Elasticsearch: 5+ node cluster with index sharding
- Consider Kafka for higher throughput if needed

### Monitoring and Capacity Planning

**Key Metrics:**
- Queue depth across all queues
- Message processing rate (messages/second)
- End-to-end processing latency (file ingestion → export)
- Component CPU and memory utilization
- File system I/O wait times

**Alerts:**
- Queue depth > 500: Warning (may need more consumers)
- Queue depth > 1000: Critical (add consumers immediately)
- Processing latency > 2 minutes: Warning
- Processing latency > 5 minutes: Critical
- Any message in dead letter queue: Critical

**Capacity Planning:**
- Review metrics monthly
- Forecast growth based on file volume trends
- Provision capacity for 2x current peak load
- Maintain 50% headroom for unexpected spikes

## Services Drill Down

This section provides detailed architecture and design specifications for each service component in the PayRawl payment processing pipeline.

### File Handler

**Purpose**: Gateway component that monitors file system and ingests payment files into the processing pipeline

**What it does:**
- Continuously monitors designated source folders for new payment files
- Detects new files immediately using file system watchers
- Retrieves file contents and metadata
- Publishes file data to Files Queue for downstream processing
- Logs all ingestion events with timestamps and file details

**What it does NOT do:**
- Process or validate file contents (File Formatters responsibility)
- Perform format detection (File Formatters responsibility)
- Apply business logic (File Calculation responsibility)

**Architecture Decision Process:**

**1. Application Type:**
- **What it does**:
  - Run continuously 24/7 monitoring file system
  - No HTTP interface or user interaction
  - Publish messages to RabbitMQ queue
  - Handle file I/O operations
  
- **Type Decision**: Background Service (continuously running, no UI)
  - ✅ Background Service (.NET Core Worker Service): Suitable for long-running processes
  - ❌ Console Application: Not suitable for production 24/7 operation
  - ❌ Web API: No HTTP interface needed

**2. Technology Stack Selection:**

**Context**: Greenfield project with no existing technology constraints

**Selection Criteria:**
- Performance and efficiency
- Strong community support and ecosystem
- Cross-platform compatibility
- Ease of development and maintenance
- Future viability and corporate backing
- Threading and concurrency support
- File I/O and queue integration capabilities

**Candidates Evaluated:**

| Technology    | Performance | Community   | Cross-Platform | Ease of Use            | Future Prospects       | Threading                 | Decision                 |
| ------------- | ----------- | ----------- | -------------- | ---------------------- | ---------------------- | ------------------------- | ------------------------ |
| **.NET Core** | Excellent   | Strong      | ✅ Yes          | High (C# productivity) | Microsoft backing      | Good (async/await)        | ✅ **Selected**           |
| **Java**      | Very Good   | Very Strong | ✅ Yes          | Moderate (verbose)     | Oracle + OSS community | Excellent (mature)        | ❌ More complex           |
| **Node.js**   | Good (I/O)  | Strong      | ✅ Yes          | High (JavaScript)      | Strong ecosystem       | Limited (single-threaded) | ❌ Not ideal for services |
| **Python**    | Moderate    | Strong      | ✅ Yes          | Very High              | Strong in data/ML      | Limited (GIL)             | ❌ Performance concerns   |

**Selected Solution: .NET Core**

**Rationale:**
- **Performance**: Superior performance, especially for I/O operations and background services
- **Productivity**: C# language features, strong typing, excellent IDE support (Visual Studio, Rider)
- **Async Support**: Native async/await makes file watching and queue operations clean and efficient
- **Cross-Platform**: Runs on Windows, Linux, macOS
- **RabbitMQ Integration**: Excellent client libraries (RabbitMQ.Client)
- **File System**: Robust FileSystemWatcher for monitoring folders
- **Future-Proof**: Strong Microsoft commitment and investment

**3. Architecture Design:**

**Pattern**: Service-Oriented Background Worker with Modular Components

**Modules:**

1. **File Watcher Module**
   - **Purpose**: Monitor designated source folders for new files
   - **Technology**: .NET FileSystemWatcher
   - **Responsibilities**:
     - Watch multiple source folders concurrently
     - Detect Created, Renamed, and Changed events
     - Filter for payment file extensions
     - Debounce events to avoid duplicate processing
     - Handle file locking scenarios (wait for complete file write)

2. **File Reader Module**
   - **Purpose**: Read file contents safely and efficiently
   - **Responsibilities**:
     - Open files with appropriate sharing modes
     - Read file contents with retry logic (handle locks)
     - Extract file metadata (name, size, timestamp)
     - Validate file accessibility before publishing

3. **Queue Publisher Module**
   - **Purpose**: Publish file data to RabbitMQ Files Queue
   - **Technology**: RabbitMQ.Client library
   - **Responsibilities**:
     - Establish and maintain RabbitMQ connection
     - Publish messages to Files Queue
     - Set message persistence flag for durability
     - Handle connection failures with automatic reconnection
     - Implement publisher confirms for reliability

4. **Logging Module**
   - **Purpose**: Log all operations for audit trail
   - **Technology**: Serilog with Elasticsearch sink
   - **Responsibilities**:
     - Log file ingestion events
     - Log errors and exceptions
     - Log queue publishing status
     - Structured logging with correlation IDs

**Component Diagram:**
```
[File System]
      ↓ (file created)
[File Watcher Module] → [File Reader Module] → [Queue Publisher Module] → [RabbitMQ Files Queue]
      ↓                        ↓                         ↓
                   [Logging Module (Serilog)] → [Elasticsearch]
```

**4. Redundancy & High Availability:**

**Pattern: Is-Alive Mechanism (Active-Standby)**

**Why Not Consumer Groups?**
- File Handler is a publisher, not a consumer
- Multiple active instances would cause duplicate file processing
- File system watching is stateful and requires coordination

**Is-Alive Implementation:**
1. Deploy 2+ instances of File Handler
2. Only one instance is "Active" at any time, others are "Standby"
3. Active instance periodically updates heartbeat in shared storage (database/Redis)
4. Standby instances monitor heartbeat
5. If heartbeat expires, standby instance becomes active

**Heartbeat Mechanism:**
- Active instance: Write heartbeat every 5 seconds
- Standby instances: Check heartbeat every 10 seconds
- Heartbeat timeout: 30 seconds (6 missed heartbeats)
- On timeout: Standby initiates activation process

**Activation Process:**
1. Attempt to acquire lock in shared storage
2. If lock acquired, become Active and start file watching
3. If lock acquisition fails, another standby won the race, remain Standby

**Shared Storage Options:**
- SQL Server with lock table
- Redis with atomic operations (SET NX)
- Distributed coordination service (e.g., Consul, etcd)

**Failover Time:** < 30 seconds (heartbeat timeout)

**5. Error Handling:**

**File System Errors:**
- File locked by another process: Retry with exponential backoff (max 3 attempts)
- File deleted before reading: Log warning, skip file
- Folder inaccessible: Log critical error, alert operations, retry connection

**Queue Publishing Errors:**
- Connection failure: Automatic reconnection with exponential backoff
- Publishing failure: Retry up to 3 times, then log to dead letter file location
- Confirmation timeout: Retry publishing

**Monitoring:**
- Files processed per minute
- Queue publishing success rate
- Error rate and error types
- Active instance status
- Heartbeat status

![File Handler Architecture](./diagrams/file-handler-service.png)

---

### File Formatters

**Purpose**: Normalize diverse payment file formats to a unified internal format for consistent downstream processing

**What it does:**
- Consume payment files from Files Queue
- Detect file format (via extension, magic numbers, or metadata)
- Select appropriate formatter plugin for detected format
- Parse and validate file structure and data
- Transform to standardized internal format (e.g., canonical JSON schema)
- Publish normalized files to Formatted Files Queue
- Log format conversion events and any validation errors

**What it does NOT do:**
- Apply business calculations (File Calculation responsibility)
- Generate output files (File Exporter responsibility)
- Determine file source or destination (handled by File Handler and Exporter)

**Architecture Decision Process:**

**1. Application Type:**
- **Type Decision**: Background Service (queue consumer)
  - ✅ Background Service (.NET Core Worker Service): Suitable for continuous queue processing
  - ❌ Web API: No HTTP interface needed
  - ❌ Function-as-a-Service: Too much overhead for continuous processing

**2. Technology Stack:**
- **Framework**: .NET Core (consistency with File Handler)
- **Rationale**: 
  - Same benefits as File Handler
  - Code reuse for queue integration
  - Easy to implement formatter plugins via interfaces
  - Strong XML/JSON parsing libraries

**3. Architecture Design:**

**Pattern**: Plugin-Based Service Architecture with Strategy Pattern

**Modules:**

1. **Queue Consumer Module**
   - **Purpose**: Consume files from Files Queue
   - **Technology**: RabbitMQ.Client
   - **Responsibilities**:
     - Establish connection to RabbitMQ
     - Subscribe to Files Queue
     - Receive messages with manual acknowledgment
     - Deserialize message payload
     - Pass files to Formatter Manager
     - Acknowledge successful processing
     - Negative-acknowledge (NACK) failed messages

2. **Formatter Manager Module**
   - **Purpose**: Coordinate format detection and conversion
   - **Responsibilities**:
     - Detect file format (extension, content inspection)
     - Select appropriate formatter plugin
     - Invoke formatter with file data
     - Handle formatter exceptions
     - Return standardized output

3. **Formatter Plugins Module**
   - **Purpose**: Format-specific parsing and conversion logic
   - **Design**: Strategy Pattern with common interface
   - **Interface**: `IPaymentFileFormatter`
     ```csharp
     public interface IPaymentFileFormatter
     {
         string SupportedFormat { get; }
         bool CanHandle(FileMetadata metadata);
         StandardizedPaymentFile Parse(byte[] fileContent);
         void Validate(StandardizedPaymentFile file);
     }
     ```
   - **Example Formatters**:
     - CSV Formatter
     - XML Formatter
     - JSON Formatter
     - Fixed-Width Formatter
     - Custom proprietary format formatters

4. **Queue Publisher Module**
   - **Purpose**: Publish formatted files to Formatted Files Queue
   - **Responsibilities**:
     - Serialize standardized format
     - Publish to Formatted Files Queue
     - Ensure message persistence
     - Handle publishing failures

5. **Logging Module**
   - **Purpose**: Log formatting operations
   - **Technology**: Serilog with Elasticsearch sink
   - **Responsibilities**:
     - Log format detection and conversion
     - Log validation errors
     - Log processing metrics (time, success/failure)
     - Correlation ID tracking across pipeline

**Standardized Internal Format:**
```json
{
  "fileId": "unique-identifier",
  "sourceFormat": "CSV",
  "processedTimestamp": "2026-01-08T10:30:00Z",
  "metadata": {
    "fileName": "payment_batch_001.csv",
    "sourceFolder": "/input/daily",
    "fileSize": 1048576
  },
  "payments": [
    {
      "paymentId": "PAY-001",
      "amount": 1000.00,
      "currency": "USD",
      "sender": { "accountNumber": "123456", "name": "John Doe" },
      "recipient": { "accountNumber": "789012", "name": "Jane Smith" },
      "paymentDate": "2026-01-10",
      "reference": "INV-2026-001"
    }
  ]
}
```

**Component Diagram:**
```
[Files Queue] → [Queue Consumer] → [Formatter Manager] → [Formatter Plugins]
                                                              ↓
[Formatted Files Queue] ← [Queue Publisher] ← [Standardized Format]
         ↓
  [Logging Module] → [Elasticsearch]
```

**4. Extensibility - Adding New Formatters:**

**Steps to Add New Format:**
1. Implement `IPaymentFileFormatter` interface
2. Add formatter class to project
3. Register formatter in Dependency Injection container
4. Deploy updated service (no configuration changes needed)
5. Formatter Manager automatically discovers and uses new formatter

**Example: Adding SWIFT MT103 Formatter:**
```csharp
public class SwiftMT103Formatter : IPaymentFileFormatter
{
    public string SupportedFormat => "SWIFT-MT103";
    
    public bool CanHandle(FileMetadata metadata) =>
        metadata.Extension == ".mt103" || 
        metadata.Content.StartsWith("{1:F01");
    
    public StandardizedPaymentFile Parse(byte[] fileContent)
    {
        // Parse SWIFT MT103 format
        // Convert to StandardizedPaymentFile
    }
    
    public void Validate(StandardizedPaymentFile file)
    {
        // SWIFT-specific validations
    }
}
```

**5. Redundancy & Scalability:**

**Pattern: Consumer Group (Multiple Active Consumers)**

**Why Consumer Group?**
- File Formatters are stateless consumers
- Each message can be processed independently
- No coordination needed between instances
- RabbitMQ automatically distributes messages across consumers

**Implementation:**
1. Deploy N instances of File Formatters service
2. All instances subscribe to same queue (Files Queue)
3. RabbitMQ round-robin distributes messages
4. Each instance processes different files concurrently
5. Manual acknowledgment ensures exactly-once processing

**Load Balancing:**
- Automatic via RabbitMQ queue consumption
- Faster consumers process more messages
- Failed messages return to queue for retry

**Scaling:**
- Add instances when Files Queue depth increases
- Remove instances during low traffic
- Kubernetes HPA (Horizontal Pod Autoscaler) can automate

**6. Error Handling:**

**Validation Errors:**
- Invalid file format: Log error, send to dead letter queue, alert
- Malformed data: Log error, attempt best-effort parsing, or reject
- Missing required fields: Reject file, send to error queue

**Processing Errors:**
- Formatter exception: Log error, NACK message, retry (max 3 times)
- Queue publishing failure: Retry with exponential backoff
- Persistent failures: Send to dead letter queue for manual review

**Dead Letter Queue:**
- Failed messages after max retries moved to DLQ
- Operations team reviews and reprocesses manually
- Prevents single bad file from blocking entire pipeline

**Monitoring:**
- Messages processed per minute
- Format distribution (CSV, XML, JSON percentages)
- Validation error rate by format
- Processing time per format
- Queue depth and lag

---

### File Calculation

**Purpose**: Apply business rules and perform financial calculations on normalized payment data

**What it does:**
- Consume formatted files from Formatted Files Queue
- Execute business logic and calculation rules
- Calculate fees, commissions, tax withholdings
- Perform currency conversions if needed
- Apply payment validation rules
- Enrich payment records with calculated fields
- Publish calculated files to Calculated Files Queue
- Log all calculation operations and results

**What it does NOT do:**
- Format conversion (File Formatters responsibility)
- File generation or export (File Exporter responsibility)
- Modify original payment data (only adds calculated fields)

**Architecture Decision Process:**

**1. Application Type:**
- **Type Decision**: Background Service (queue consumer)
  - ✅ Background Service (.NET Core Worker Service): Consistent with other pipeline components
  - Similar architecture to File Formatters

**2. Technology Stack:**
- **Framework**: .NET Core (consistency across pipeline)
- **Rationale**:
  - Decimal precision for financial calculations (C# decimal type)
  - Strong type safety for money calculations
  - Rich math and calculation libraries
  - Consistency with rest of pipeline

**3. Architecture Design:**

**Pattern**: Service-Oriented with Business Rules Engine

**Modules:**

1. **Queue Consumer Module**
   - **Purpose**: Consume formatted files from Formatted Files Queue
   - **Technology**: RabbitMQ.Client
   - **Responsibilities**:
     - Connect to RabbitMQ
     - Subscribe to Formatted Files Queue
     - Receive messages with manual acknowledgment
     - Pass files to Calculation Engine
     - Acknowledge successful processing

2. **Calculation Engine Module**
   - **Purpose**: Execute all business calculations
   - **Responsibilities**:
     - Load payment data from standardized format
     - Apply calculation rules sequentially or in parallel
     - Calculate transaction fees (flat, percentage-based)
     - Apply commissions for intermediaries
     - Calculate tax withholdings
     - Perform currency conversions using exchange rates
     - Validate calculated amounts against limits
     - Enrich payment records with calculated fields

3. **Business Rules Module**
   - **Purpose**: Encapsulate business logic and calculation formulas
   - **Design**: Strategy or Rules Engine pattern
   - **Rules Examples**:
     - Fee calculation: `0.5% of amount, min $1, max $100`
     - Commission calculation: `0.25% of amount to intermediary`
     - Tax withholding: `10% for international payments`
     - Amount limits: `Max $50,000 per transaction`
     - Currency conversion: `Use daily exchange rates from provider`

4. **Exchange Rate Service**
   - **Purpose**: Provide currency conversion rates
   - **Options**:
     - Call external API (e.g., ECB, XE.com)
     - Use cached rates updated daily
     - Fallback to previous day's rates if API unavailable

5. **Queue Publisher Module**
   - **Purpose**: Publish calculated files to Calculated Files Queue
   - **Responsibilities**:
     - Serialize enriched payment data
     - Publish to Calculated Files Queue
     - Ensure message persistence

6. **Logging Module**
   - **Purpose**: Log calculation operations
   - **Technology**: Serilog with Elasticsearch sink
   - **Responsibilities**:
     - Log calculations performed
     - Log exchange rates used
     - Log validation results
     - Track processing metrics

**Calculated Payment Format (Extended):**
```json
{
  "fileId": "unique-identifier",
  "sourceFormat": "CSV",
  "processedTimestamp": "2026-01-08T10:30:00Z",
  "calculatedTimestamp": "2026-01-08T10:31:00Z",
  "metadata": { ... },
  "payments": [
    {
      "paymentId": "PAY-001",
      "amount": 1000.00,
      "currency": "USD",
      "sender": { ... },
      "recipient": { ... },
      "paymentDate": "2026-01-10",
      "reference": "INV-2026-001",
      "calculations": {
        "transactionFee": 5.00,
        "feeCalculationMethod": "0.5% of amount",
        "commission": 2.50,
        "taxWithholding": 0.00,
        "exchangeRate": null,
        "convertedAmount": null,
        "totalDebitAmount": 1007.50,
        "totalCreditAmount": 997.50,
        "netAmount": 995.00
      },
      "validations": {
        "withinLimits": true,
        "maximumAmount": 50000.00,
        "validationTimestamp": "2026-01-08T10:31:00Z"
      }
    }
  ]
}
```

**Component Diagram:**
```
[Formatted Files Queue] → [Queue Consumer] → [Calculation Engine] ⟷ [Business Rules]
                                                    ↓                      ↓
                                            [Exchange Rate Service]
                                                    ↓
[Calculated Files Queue] ← [Queue Publisher] ← [Enriched Payment Data]
         ↓
  [Logging Module] → [Elasticsearch]
```

**4. Business Rules Management:**

**Current Approach: Code-Based Rules**
- Rules implemented as C# classes
- Changes require code deployment
- Suitable for stable, infrequently changing rules

**Future Enhancement: Rules Engine**
- Externalize rules to configuration or database
- Allow rules updates without deployment
- Consider rules engine libraries (e.g., Rules Engine, NRules)
- Enable business user rule management

**5. Redundancy & Scalability:**

**Pattern: Consumer Group (Multiple Active Consumers)**

**Implementation:**
- Deploy N instances of File Calculation service
- All instances subscribe to Formatted Files Queue
- RabbitMQ distributes messages across instances
- Parallel processing of independent payment files
- Manual acknowledgment for reliability

**Scaling Considerations:**
- CPU-intensive if complex calculations
- May need more instances than Formatters
- Scale based on Formatted Files Queue depth
- Monitor CPU utilization per instance

**Horizontal Scaling:**
- Add instances during high calculation load
- Kubernetes HPA based on CPU or queue depth metrics

**6. Error Handling:**

**Calculation Errors:**
- Division by zero: Log error, use default value or reject
- Invalid exchange rate: Use cached rate or reject with alert
- Amount limit exceeded: Reject payment, log violation
- Missing required data: Log error, reject payment

**Processing Errors:**
- Calculation exception: Log error, NACK message, retry (max 3 times)
- Queue publishing failure: Retry with exponential backoff
- Persistent failures: Send to dead letter queue

**Validation Failures:**
- Out-of-limit amounts: Mark as invalid, log, still publish for reporting
- Invalid currency codes: Reject payment, log error
- Missing exchange rates: Alert, use fallback, or reject

**Monitoring:**
- Calculations processed per minute
- Average calculation time per file
- Error rate by error type
- Exchange rate API availability
- Queue depth and processing lag
- Business metrics: Total fees calculated, total amount processed

---

### File Exporter

**Purpose**: Generate bank-specific payment instruction files and deliver to designated bank folders

**What it does:**
- Consume calculated files from Calculated Files Queue
- Transform standardized payment data to bank-specific formats
- Generate compliant payment instruction files per bank specifications
- Write files to designated bank folders
- Handle file naming conventions per bank requirements
- Log export operations and delivery confirmations
- Retry file writes on transient failures

**What it does NOT do:**
- Perform calculations (File Calculation responsibility)
- Validate payment limits (File Calculation responsibility)
- Monitor bank file pickup (out of scope - bank responsibility)

**Architecture Decision Process:**

**1. Application Type:**
- **Type Decision**: Background Service (queue consumer)
  - ✅ Background Service (.NET Core Worker Service): Consistent with pipeline

**2. Technology Stack:**
- **Framework**: .NET Core (consistency)
- **Rationale**:
  - Strong file I/O capabilities
  - Template engines for file generation
  - Error handling and retry logic

**3. Architecture Design:**

**Pattern**: Service-Oriented with Template-Based File Generation

**Modules:**

1. **Queue Consumer Module**
   - **Purpose**: Consume calculated files from Calculated Files Queue
   - **Technology**: RabbitMQ.Client
   - **Responsibilities**:
     - Connect to RabbitMQ
     - Subscribe to Calculated Files Queue
     - Receive messages with manual acknowledgment
     - Pass files to Exporter Manager

2. **Exporter Manager Module**
   - **Purpose**: Orchestrate file generation and delivery
   - **Responsibilities**:
     - Determine target bank(s) based on payment data
     - Select appropriate export template
     - Invoke template generator
     - Coordinate file writing
     - Handle errors and retries

3. **Bank Templates Module**
   - **Purpose**: Bank-specific file format templates
   - **Design**: Strategy Pattern with common interface
   - **Interface**: `IBankExportTemplate`
     ```csharp
     public interface IBankExportTemplate
     {
         string BankCode { get; }
         string FileExtension { get; }
         string GenerateFileName(DateTime timestamp, string batchId);
         byte[] GenerateFile(StandardizedPaymentFile calculatedFile);
         void ValidateOutput(byte[] fileContent);
     }
     ```
   - **Example Templates**:
     - NACHA (ACH) format
     - SWIFT MT103 format
     - ISO 20022 XML format
     - Bank-specific proprietary formats

4. **File Writer Module**
   - **Purpose**: Write files to designated folders
   - **Responsibilities**:
     - Write files atomically (temp file + rename)
     - Set appropriate file permissions
     - Handle concurrent writes
     - Retry on transient failures
     - Verify file written successfully

5. **Delivery Tracker Module**
   - **Purpose**: Track file delivery status
   - **Responsibilities**:
     - Record file delivery attempts
     - Log successful deliveries
     - Track delivery failures
     - Maintain delivery audit trail

6. **Logging Module**
   - **Purpose**: Log export operations
   - **Technology**: Serilog with Elasticsearch sink
   - **Responsibilities**:
     - Log file generation events
     - Log file delivery status
     - Log errors and retries
     - Track export metrics

**Component Diagram:**
```
[Calculated Files Queue] → [Queue Consumer] → [Exporter Manager] → [Bank Templates]
                                                      ↓                   ↓
                                              [File Writer] → [Bank Folders]
                                                      ↓
                                            [Delivery Tracker]
                                                      ↓
                                            [Logging Module] → [Elasticsearch]
```

**4. Bank File Format Examples:**

**NACHA ACH Format (Fixed-Width):**
```
101 123456789 0987654321 2601080900A094101BANK NAME           COMPANY NAME     
5200COMPANY NAME                        1234567890PPDPAYROLL         260108   1123456780000001
622012345678901234567890       0000100000      John Doe              0123456780000001
...
```

**SWIFT MT103 Format:**
```
{1:F01BANKUS33AXXX0000000000}
{2:O1031200260108BANKGB2LXXXX00000000002601081200N}
{3:{108:MT103}}
{4:
:20:REFERENCE-001
:32A:260110USD1000,00
:50K:SENDER NAME
SENDER ADDRESS
:59:RECIPIENT NAME
RECIPIENT ADDRESS
:71A:OUR
-}
```

**ISO 20022 XML Format:**
```xml
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>MSG-001</MsgId>
      <CreDtTm>2026-01-08T10:30:00</CreDtTm>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>BATCH-001</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      ...
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
```

**5. Redundancy & Scalability:**

**Pattern: Consumer Group with Coordination**

**Challenge:**
- Multiple instances could write duplicate files to bank folders
- Need to prevent duplicate file delivery

**Solution 1: Consumer Group with Idempotent File Names**
- Generate unique file names including timestamp + instance ID
- Multiple instances can write concurrently without conflicts
- File names like: `payments_20260108_103000_inst1.ach`

**Solution 2: Distributed Locking**
- Use distributed lock per bank folder
- Only one instance writes to specific bank folder at a time
- Other instances process different banks or wait

**Solution 3: Single Active Consumer Per Bank**
- Partition queues by bank
- One consumer group per bank queue
- Scales by number of banks, not overall load

**Recommended: Solution 1 (Idempotent File Names)**
- Simplest implementation
- No coordination overhead
- Scales horizontally easily
- Banks handle multiple files per batch period

**6. Error Handling:**

**File Generation Errors:**
- Template error: Log error, NACK message, retry
- Invalid data for bank format: Log error, send to error queue for review
- Missing required fields: Reject, alert operations

**File Writing Errors:**
- Folder not accessible: Retry with backoff, alert after 3 failures
- Disk full: Alert critical, pause processing until resolved
- Permission denied: Alert operations, check configuration

**Retry Strategy:**
- Transient errors (network, temp folder issues): Retry 3 times with exponential backoff
- Permanent errors (invalid data, missing config): Send to DLQ, alert

**Dead Letter Queue Processing:**
- Operations team reviews failed exports
- Fix data or configuration issues
- Manually reprocess or resubmit to queue

**Monitoring:**
- Files exported per minute by bank
- Export success rate by bank
- File generation time per bank format
- File delivery success rate
- Queue depth and processing lag
- Bank folder availability status

---

### Logging Service (Elastic Stack)

**Purpose**: Centralized logging, search, analytics, and visualization for entire PayRawl pipeline

**What it does:**
- Collect logs from all PayRawl components
- Index logs for fast full-text search
- Provide dashboards for operational monitoring
- Enable troubleshooting and root cause analysis
- Support 7-year log retention for regulatory compliance
- Generate alerts for error conditions
- Provide analytics on processing metrics

**What it does NOT do:**
- Store payment data (only logs and metadata)
- Process payments (observability only)
- Trigger automated remediation (monitoring and alerting only)

**Technology: Elastic Stack**

**Components:**

1. **Elasticsearch**
   - **Purpose**: Search and analytics engine for log storage and indexing
   - **Capabilities**:
     - Full-text search across all logs
     - Aggregations for metrics and analytics
     - Time-series data optimization
     - Horizontal scaling via sharding
     - Data retention via Index Lifecycle Management (ILM)

2. **Kibana**
   - **Purpose**: Visualization and analytics platform
   - **Capabilities**:
     - Build custom dashboards
     - Create visualizations (charts, graphs, maps)
     - Search and explore logs interactively
     - Set up alerts and notifications
     - Monitor cluster health

3. **Logstash**
   - **Purpose**: Log collection pipeline for RabbitMQ logs
   - **Capabilities**:
     - Pull logs from RabbitMQ via plugin
     - Transform and enrich log data
     - Route logs to Elasticsearch
     - Filter and parse various log formats

4. **Beats (Alternative to Logstash)**
   - **Purpose**: Lightweight log shippers
   - **Options**:
     - Filebeat: Ship logs from files
     - Metricbeat: Ship system metrics
   - **Advantages**: Lower resource footprint than Logstash

**Architecture Design:**

**Log Shipping Strategies:**

**For .NET Services (File Handler, Formatters, Calculation, Exporter):**
- **Method**: Direct shipping via Serilog Elasticsearch sink
- **Flow**: 
  ```
  .NET Service → Serilog → Elasticsearch Sink → Elasticsearch
  ```
- **Configuration**:
  ```csharp
  Log.Logger = new LoggerConfiguration()
      .WriteTo.Elasticsearch(new ElasticsearchSinkOptions(
          new Uri("http://elasticsearch:9200"))
      {
          AutoRegisterTemplate = true,
          IndexFormat = "payrawl-{0:yyyy.MM}",
          FailureCallback = e => Console.WriteLine($"Elasticsearch error: {e}"),
          EmitEventFailure = EmitEventFailureHandling.WriteToSelfLog
      })
      .CreateLogger();
  ```
- **Benefits**:
  - No intermediate log shipping component
  - Low latency logging
  - Structured logging (JSON format)
  - Correlation IDs for distributed tracing

**For RabbitMQ:**
- **Method**: Logstash with RabbitMQ input plugin
- **Flow**:
  ```
  RabbitMQ Logs → Logstash RabbitMQ Input → Logstash Pipeline → Elasticsearch
  ```
- **Logstash Configuration**:
  ```
  input {
    rabbitmq {
      host => "rabbitmq-server"
      queue => "logs"
      durable => true
    }
  }
  
  filter {
    json {
      source => "message"
    }
    date {
      match => [ "timestamp", "ISO8601" ]
    }
  }
  
  output {
    elasticsearch {
      hosts => ["elasticsearch:9200"]
      index => "payrawl-rabbitmq-%{+YYYY.MM}"
    }
  }
  ```

**Log Structure (Standardized):**
```json
{
  "@timestamp": "2026-01-08T10:30:00.123Z",
  "level": "INFO",
  "service": "file-handler",
  "instance": "file-handler-1",
  "correlationId": "abc123-def456",
  "messageTemplate": "File ingested: {FileName}",
  "message": "File ingested: payment_001.csv",
  "fields": {
    "fileName": "payment_001.csv",
    "fileSize": 1048576,
    "sourceFolder": "/input/daily"
  },
  "exception": null
}
```

**Data Retention Strategy:**

**Index Lifecycle Management (ILM):**
- **Hot Phase** (0-7 days): 
  - Store on fast SSD storage
  - Actively indexing and querying
  - Full search capabilities

- **Warm Phase** (7-90 days):
  - Move to slower storage
  - Read-only, no new writes
  - Still searchable, slightly slower

- **Cold Phase** (90 days - 7 years):
  - Move to cold storage (S3, cheap disks)
  - Rarely accessed
  - Search available but slower
  - Compressed for space efficiency

- **Delete Phase** (> 7 years):
  - Automatically delete indices older than 7 years
  - Meets regulatory retention requirement

**Storage Estimation:**
- Daily logs: ~250 MB/day
- 7 years: ~640 GB
- With compression and cold storage: ~320 GB

**Kibana Dashboards:**

**Operational Dashboard:**
- Files processed per minute (line chart)
- Processing success rate (gauge)
- Error count by service (pie chart)
- Current queue depths (bar chart)
- Active service instances (status indicators)

**Performance Dashboard:**
- End-to-end processing latency (histogram)
- Per-stage processing time (stacked bar chart)
- Queue lag over time (area chart)
- Throughput by hour of day (heatmap)

**Error Dashboard:**
- Error rate over time (line chart)
- Error types distribution (pie chart)
- Top error messages (table)
- Errors by service (bar chart)
- Failed file list (data table with drill-down)

**Business Analytics Dashboard:**
- Total payment amount processed per day
- Payment count by currency
- Average transaction fee collected
- Format distribution (CSV, XML, JSON percentages)
- Bank distribution (payments per bank)

**Alerting:**

**Critical Alerts:**
- Any service down (no logs for 5 minutes)
- Error rate > 5%
- Queue depth > 1000 messages
- Disk space < 10% on Elasticsearch
- Any message in dead letter queue

**Warning Alerts:**
- Error rate > 2%
- Processing latency > 2 minutes (avg)
- Queue depth > 500 messages
- Elasticsearch cluster health: yellow

**Notification Channels:**
- Critical: PagerDuty, SMS, email
- Warning: Email, Slack
- Info: Dashboard only

**Redundancy & High Availability:**

**Elasticsearch Cluster:**
- 3-node cluster for production
- Data replicated across nodes
- Automatic failover if node fails
- Rolling updates without downtime

**Kibana:**
- 2+ instances behind load balancer
- Stateless, easy to scale

**Logstash:**
- 2+ instances for redundancy
- If one fails, RabbitMQ messages remain durable
- Other instance continues processing

**Why Elastic Stack?**

**Decision: Use Elastic Stack (not custom solution)**

| Aspect                 | Elastic Stack                                  | Custom Solution              |
| ---------------------- | ---------------------------------------------- | ---------------------------- |
| **Development Effort** | Minimal (configuration only)                   | High (build everything)      |
| **Maintenance**        | Lower (community support)                      | Higher (custom maintenance)  |
| **Features**           | Enterprise-grade search, analytics, dashboards | Limited to what we build     |
| **Scalability**        | Proven at massive scale                        | Need to architect carefully  |
| **Time to Market**     | Days/weeks                                     | Months                       |
| **Cost**               | Open-source (free) + infrastructure            | Development + infrastructure |
| **Risk**               | Low (battle-tested)                            | High (unproven custom code)  |

**Verdict**: ✅ Elastic Stack is the clear choice
- Established, mature platform
- Exactly meets requirements (search, analytics, retention)
- Open-source with strong community
- Horizontal scaling built-in
- Faster implementation than custom solution
- Lower long-term maintenance burden## Technology Decisions

### Message Queue Technology

**Purpose**: Enable reliable, asynchronous communication between pipeline stages with zero data loss

**Technology Evaluation:**

| Technology            | Description                          | Pros                                                                                                                                                                                                 | Cons                                                                                                                              | Decision       |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **RabbitMQ**          | General-purpose message broker       | - Easy to set up and use<br>- Supports multiple messaging patterns<br>- Mature and battle-tested<br>- Strong durability guarantees<br>- Good community and documentation<br>- Management UI included | - Not designed for ultra-high throughput<br>- Single-node can be bottleneck<br>- Clustering adds complexity                       | ✅ **Selected** |
| **AWS SQS**           | Fully managed cloud message queue    | - Fully managed (no maintenance)<br>- Highly scalable and reliable<br>- Pay-as-you-go pricing<br>- Integrated with AWS ecosystem                                                                     | - Cloud vendor lock-in<br>- Higher latency than self-hosted<br>- Costs increase with volume<br>- Less control over infrastructure | ❌ Not suitable |
| **Apache Kafka**      | Distributed event streaming platform | - Extremely high throughput<br>- Distributed and scalable by design<br>- Durable message storage<br>- Built for streaming data<br>- Strong replay capabilities                                       | - Complex to set up and operate<br>- Requires more resources<br>- Overkill for batch file processing<br>- Steeper learning curve  | ❌ Overkill     |
| **Azure Service Bus** | Cloud message broker                 | - Fully managed<br>- Enterprise messaging features<br>- Good Azure integration                                                                                                                       | - Cloud vendor lock-in<br>- Cost considerations<br>- Less deployment flexibility                                                  | ❌ Not suitable |

**Selected Solution: RabbitMQ**

**Rationale:**
- **Appropriate Scale**: 500 files/day is moderate throughput, not streaming data
- **Ease of Use**: Simple setup, intuitive management UI
- **Durability**: Excellent message persistence for zero data loss requirement
- **Patterns**: Supports all needed patterns (pub/sub, point-to-point, work queues)
- **On-Premise**: Can deploy on-premise without cloud dependency
- **Cost**: Open-source with no licensing fees
- **Consumer Groups**: Native support for work queues with multiple consumers
- **Monitoring**: Built-in management plugin for operational visibility

**Configuration for PayRawl:**
- **Durable Queues**: All queues configured as durable
- **Persistent Messages**: All messages marked as persistent
- **Manual Acknowledgment**: Consumers manually ACK after processing
- **Prefetch Count**: Limit to 1-5 messages per consumer to balance load
- **Dead Letter Queues**: Configured for all queues to handle failures
- **Message TTL**: Optional timeout for old messages
- **Queue Length Limits**: Alert when queue depth exceeds thresholds

---

### Programming Language / Framework

**Purpose**: Build all processing services (File Handler, Formatters, Calculation, Exporter)

**Selection Criteria:**
- Performance and efficiency
- Community support and ecosystem
- Cross-platform compatibility
- Developer productivity and ease of use
- Future viability and corporate backing
- Threading and concurrency support
- Integration capabilities (file I/O, queues, logging)

**Candidates Evaluated:**

| Technology              | Performance | Community   | Cross-Platform | Ease of Use | Future            | Threading               | Decision                |
| ----------------------- | ----------- | ----------- | -------------- | ----------- | ----------------- | ----------------------- | ----------------------- |
| **.NET Core / .NET 6+** | Excellent   | Strong      | ✅ Yes          | High        | Microsoft backing | Good (async/await)      | ✅ **Selected**          |
| **Java / Spring Boot**  | Very Good   | Very Strong | ✅ Yes          | Moderate    | Strong ecosystem  | Excellent               | ❌ More verbose          |
| **Node.js**             | Good (I/O)  | Strong      | ✅ Yes          | High        | Strong            | Limited (single-thread) | ❌ Not ideal             |
| **Python**              | Moderate    | Strong      | ✅ Yes          | Very High   | Strong            | Limited (GIL)           | ❌ Performance           |
| **Go**                  | Excellent   | Growing     | ✅ Yes          | Moderate    | Google backing    | Excellent (goroutines)  | ❌ Less mature ecosystem |

**Selected Solution: .NET Core (C#)**

**Rationale:**
- **Performance**: Excellent performance, especially for I/O-bound operations
- **Productivity**: C# is highly productive with strong typing, LINQ, and modern language features
- **Async Support**: First-class async/await support perfect for file I/O and queue operations
- **Cross-Platform**: Runs on Windows, Linux, macOS - deployment flexibility
- **Libraries**: Excellent libraries for RabbitMQ, file I/O, JSON/XML parsing
- **Worker Services**: .NET Worker Service template designed exactly for background services
- **Dependency Injection**: Built-in DI container for clean architecture
- **Logging**: Rich logging ecosystem (Serilog, NLog) with Elasticsearch integration
- **Testing**: Mature testing frameworks (xUnit, NUnit, Moq)
- **Tooling**: Excellent IDE support (Visual Studio, Rider, VS Code)
- **Community**: Large, active community with abundant resources
- **Future**: Strong Microsoft commitment and rapid evolution

**Specific .NET Features Used:**
- `BackgroundService` base class for long-running services
- `IHostedService` for service lifecycle management
- `async/await` for non-blocking I/O
- `FileSystemWatcher` for folder monitoring
- `System.Text.Json` for JSON parsing
- Entity Framework Core (if database needed)
- Serilog for structured logging

---

### Logging Platform

**Purpose**: Centralized logging, search, analytics, and 7-year retention

**Technology Evaluation:**

| Technology          | Description                             | Pros                                                                                                                                                               | Cons                                                                         | Decision         |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------- |
| **Elastic Stack**   | Elasticsearch + Kibana + Logstash/Beats | - Powerful search and analytics<br>- Excellent visualization (Kibana)<br>- Scalable and flexible<br>- Open-source<br>- Large community<br>- Purpose-built for logs | - Requires setup and maintenance<br>- Resource-intensive<br>- Learning curve | ✅ **Selected**   |
| **Splunk**          | Enterprise logging platform             | - Enterprise-grade features<br>- Excellent analytics<br>- Great support                                                                                            | - Very expensive licensing<br>- Costly at scale<br>- Less flexibility        | ❌ Too expensive  |
| **AWS CloudWatch**  | Cloud logging service                   | - Fully managed<br>- AWS integration<br>- Simple setup                                                                                                             | - Cloud vendor lock-in<br>- Limited analytics<br>- Costs scale with volume   | ❌ Vendor lock-in |
| **Custom Solution** | Build from scratch                      | - Full control<br>- Tailored to needs                                                                                                                              | - High development effort<br>- Ongoing maintenance<br>- Reinventing wheel    | ❌ Not justified  |
| **Graylog**         | Open-source log management              | - Open-source<br>- Lower resource usage than ELK<br>- Good UI                                                                                                      | - Smaller community<br>- Fewer features                                      | ❌ Less mature    |

**Selected Solution: Elastic Stack**

**Rationale:**
- **Search Power**: Elasticsearch provides fast full-text search across terabytes of logs
- **Analytics**: Built-in aggregations for metrics and business intelligence
- **Visualization**: Kibana dashboards for operational monitoring
- **Retention**: Index Lifecycle Management handles 7-year retention efficiently
- **Scalability**: Horizontal scaling via sharding and replication
- **Open-Source**: No licensing costs, community edition sufficient
- **Integration**: Direct integration from .NET via Serilog
- **Alerting**: Kibana alerting for error conditions
- **Standards**: Industry-standard solution, proven at scale
- **Ecosystem**: Rich plugin ecosystem for extensibility

**Components Used:**
- **Elasticsearch 8.x**: Core search and storage engine
- **Kibana 8.x**: Visualization and management UI
- **Logstash 8.x**: Optional, for RabbitMQ log collection
- **Filebeat**: Alternative lightweight shipper
- **Serilog.Sinks.Elasticsearch**: .NET library for direct log shipping

## Architecture Diagrams

### Logic Diagram
Illustrates the high-level components and their logical relationships in the payment processing pipeline.

![Components & Messaging System - Logic Diagram](./diagrams/components-n-messaging-system%20-%20logic%20diagram.png)

**Key Elements:**
- Processing stages: File Handler → Formatters → Calculation → Exporter
- Queue-based decoupling between each stage
- Elastic Stack collecting logs from all components
- External systems (Source Folders, Bank Folders) at boundaries

### Physical Diagram
Shows the deployment topology and infrastructure layout for PayRawl.

![Components & Messaging System - Physical Diagram](./diagrams/components-n-messaging-system%20-%20physical%20diagram.png)

**Key Elements:**
- Service instances and their deployment
- RabbitMQ cluster configuration
- Elasticsearch cluster setup
- Network communication paths
- Storage locations (file systems, databases)

### Technical Diagram
Details the technology stack and communication protocols used throughout the system.

![Components & Messaging System - Technical Diagram](./diagrams/components-n-messaging-system%20-%20technical%20diagram.png)

**Key Elements:**
- Technology choices (.NET Core, RabbitMQ, Elasticsearch)
- Protocols (AMQP for messaging, HTTP for Elasticsearch)
- Data formats (JSON for messages and logs)
- Integration points and APIs

## Data Architecture

### Data Flow

**Payment File Lifecycle:**

1. **Ingestion Stage**
   - Source: External file system (source folders)
   - Format: Various (CSV, XML, JSON, fixed-width, proprietary)
   - Size: ~1 MB average per file
   - Storage: Transient (read and enqueue)

2. **Files Queue (RabbitMQ)**
   - Format: Binary payload + metadata
   - Persistence: Durable, persisted to disk
   - Retention: Until consumed and acknowledged
   - Message Size: ~1 MB (file content)

3. **Formatting Stage**
   - Input: Original payment file (various formats)
   - Processing: Parse, validate, transform
   - Output: Standardized JSON format
   - Storage: In-memory during processing

4. **Formatted Files Queue (RabbitMQ)**
   - Format: Standardized JSON payload
   - Persistence: Durable, persisted to disk
   - Retention: Until consumed and acknowledged
   - Message Size: ~1-2 MB (structured JSON)

5. **Calculation Stage**
   - Input: Standardized payment file
   - Processing: Apply business rules, calculate fees, enrich data
   - Output: Enriched payment file with calculations
   - Storage: In-memory during processing

6. **Calculated Files Queue (RabbitMQ)**
   - Format: Enriched JSON payload
   - Persistence: Durable, persisted to disk
   - Retention: Until consumed and acknowledged
   - Message Size: ~1-2 MB (enriched JSON)

7. **Export Stage**
   - Input: Calculated payment file
   - Processing: Transform to bank-specific format
   - Output: Bank instruction file
   - Destination: Bank-specific folders

8. **Bank Folders (External File System)**
   - Format: Bank-specific (NACHA, SWIFT, ISO 20022, proprietary)
   - Retention: Temporary (until bank picks up)
   - Responsibility: Out of scope (bank systems consume)

### Data Formats

**Standardized Internal Format (JSON):**
```json
{
  "fileId": "uuid",
  "sourceFormat": "CSV",
  "processedTimestamp": "2026-01-08T10:30:00Z",
  "calculatedTimestamp": "2026-01-08T10:31:00Z",
  "metadata": {
    "fileName": "payments_20260108.csv",
    "sourceFolder": "/input/daily",
    "fileSize": 1048576,
    "receivedTimestamp": "2026-01-08T10:29:00Z"
  },
  "payments": [
    {
      "paymentId": "PAY-001",
      "amount": 1000.00,
      "currency": "USD",
      "sender": {
        "accountNumber": "123456789",
        "name": "John Doe",
        "bankCode": "BANK001"
      },
      "recipient": {
        "accountNumber": "987654321",
        "name": "Jane Smith",
        "bankCode": "BANK002"
      },
      "paymentDate": "2026-01-10",
      "reference": "INV-2026-001",
      "calculations": {
        "transactionFee": 5.00,
        "commission": 2.50,
        "taxWithholding": 0.00,
        "totalDebitAmount": 1007.50,
        "totalCreditAmount": 997.50,
        "netAmount": 995.00
      },
      "validations": {
        "withinLimits": true,
        "maximumAmount": 50000.00
      }
    }
  ]
}
```

### Data Persistence

**RabbitMQ Message Persistence:**
- All queues configured as durable
- All messages marked as persistent
- Messages written to disk before acknowledgment
- Survives RabbitMQ restart

**Elasticsearch Log Persistence:**
- All logs indexed in Elasticsearch
- Retention managed via Index Lifecycle Management (ILM)
- Hot → Warm → Cold → Delete phases
- 7-year retention policy

**No Application Database:**
- System is stateless, pipeline-based
- No persistent application state beyond queue messages
- All state flows through messages
- Shared state (Is-Alive) stored in lightweight coordination service

### Data Volume Summary

**Daily:**
- Payment files: ~500 MB
- Logs: ~250 MB
- Total: ~750 MB/day

**Annual:**
- Payment files: ~180 GB
- Logs: ~95 GB
- Total: ~275 GB/year

**7-Year Retention:**
- Payment files: ~1.3 TB
- Logs: ~640 GB (with compression in cold storage)
- Total: ~2 TB

## Security Architecture

### Authentication & Authorization

**System-to-System Authentication:**
- No human users (fully automated system)
- Service-to-service authentication:
  - RabbitMQ: Username/password per service
  - Elasticsearch: API key authentication
  - File system: OS-level permissions

**Service Accounts:**
- Each service runs under dedicated service account
- Least-privilege principle applied
- Credential rotation policy (every 90 days)

**Secrets Management:**
- Credentials stored in secure vault (Azure Key Vault, HashiCorp Vault, or Kubernetes Secrets)
- Never hardcoded in source code or configuration files
- Environment-specific secrets per deployment

### Data Protection

**Data at Rest:**
- **Payment Files**: 
  - Encrypted file system (EFS encryption, BitLocker)
  - Access restricted to service accounts only
- **RabbitMQ Messages**:
  - Disk persistence with OS-level encryption
  - Queue access controlled via permissions
- **Elasticsearch Logs**:
  - Index-level encryption available in Elasticsearch 7+
  - OS-level disk encryption as minimum

**Data in Transit:**
- **RabbitMQ**: TLS encryption for all AMQP connections
- **Elasticsearch**: HTTPS for all HTTP API calls
- **File System**: Local access (no network transmission) or encrypted network file system (NFS with Kerberos)

**Sensitive Data Handling:**
- Payment data (account numbers, amounts) considered sensitive
- PII (names, addresses) protected
- Logs contain metadata only, not full account numbers
- Masking applied in logs: `Account: ***6789` instead of full number

### Security Controls

**Network Security:**
- Firewall rules restrict access to RabbitMQ, Elasticsearch
- Services deployed in private network, not internet-facing
- Jump host or VPN required for administrative access
- No direct internet access from services

**Application Security:**
- Input validation on all file parsing
- Whitelist allowed file extensions
- File size limits enforced (max 10 MB to prevent DoS)
- Timeout limits on file processing
- Regular dependency updates for security patches

**File System Security:**
- Source folders: Read-only access for File Handler
- Bank folders: Write-only access for File Exporter
- Separate folders per bank for isolation
- File permissions: Owner-only access (0600 or 0700)

**Dead Letter Queue Security:**
- Failed messages may contain sensitive data
- DLQ access restricted to operations team only
- DLQ messages encrypted at rest
- Retention policy: 30 days, then archived or purged

### Audit Logging

**Security Events Logged:**
- Authentication success/failure (service account logins)
- File access events (read from source, write to bank folders)
- Configuration changes
- Error conditions that may indicate security issues
- Dead letter queue messages

**Audit Trail:**
- All security logs sent to Elasticsearch
- Tamper-proof (write-only indices)
- Retention: 7 years for regulatory compliance
- Access to audit logs restricted and logged itself

### Compliance

**Regulatory Requirements:**
- **PCI DSS** (if handling card payments): Encryption, access controls, audit logging
- **PSD2** (EU payments): Strong authentication, transaction monitoring
- **AML/CFT**: Transaction logging for anti-money laundering
- **Data Residency**: Payment data stored in-country if required

**Security Assessments:**
- Annual penetration testing
- Quarterly vulnerability scanning
- Code security reviews (SAST/DAST)
- Third-party security audits for certification

## Backup and Disaster Recovery

### Backup Strategy

**RabbitMQ:**
- **What**: Queue definitions, configuration, pending messages
- **Frequency**: 
  - Configuration: Daily snapshot
  - Messages: Persistent to disk (no separate backup needed)
- **Method**: RabbitMQ backup plugin or VM snapshot
- **Retention**: 30 days

**Elasticsearch:**
- **What**: All log indices
- **Frequency**: 
  - Snapshot daily for hot/warm indices
  - Cold indices snapshot weekly
- **Method**: Elasticsearch snapshot API to S3, NFS, or HDFS
- **Retention**: 
  - Daily snapshots: 30 days
  - Weekly snapshots: 1 year
  - Annual snapshots: 7 years (for compliance)

**Payment Files:**
- **Source Files**: Backup responsibility of upstream systems (out of scope)
- **Bank Files**: Backup responsibility of bank systems (out of scope)
- **In-Flight Files**: Stored durably in RabbitMQ queues (already backed up)

**Application State:**
- **Is-Alive State**: Ephemeral, no backup needed (recreated on failover)
- **Configuration**: Stored in version control (Git), deployed from CI/CD

### Disaster Recovery

**Recovery Objectives:**
- **RTO (Recovery Time Objective)**: 15 minutes
- **RPO (Recovery Point Objective)**: 0 minutes (no data loss)

**Disaster Scenarios:**

#### Scenario 1: Single Service Instance Failure
**Impact**: One instance of Formatters/Calculation/Exporter crashes

**Recovery**:
1. Consumer group automatically redistributes load to healthy instances
2. Failed instance's messages returned to queue (NACK)
3. Other instances process redistributed messages
4. Restart failed instance when ready

**Expected Recovery Time**: 0 minutes (automatic)

#### Scenario 2: File Handler Failure
**Impact**: Active File Handler instance crashes

**Recovery**:
1. Standby instance detects heartbeat timeout (30 seconds)
2. Standby acquires lock and becomes active
3. Begins monitoring source folders and publishing

**Expected Recovery Time**: < 1 minute

#### Scenario 3: RabbitMQ Failure
**Impact**: RabbitMQ server crashes or becomes unavailable

**Recovery**:
1. If persisted to disk: Restart RabbitMQ server, messages restored automatically
2. If disk failure: Restore from latest snapshot (daily backup)
3. Lost messages: Only in-flight messages not yet persisted (unlikely due to persistence)
4. Services automatically reconnect when RabbitMQ available

**Expected Recovery Time**: 5-10 minutes

#### Scenario 4: Elasticsearch Failure
**Impact**: Elasticsearch cluster unavailable

**Recovery**:
1. If node failure: Cluster automatically promotes replica shards
2. If cluster failure: Restore from snapshot
3. Services buffer logs in memory temporarily, then resume shipping

**Expected Recovery Time**: 10-15 minutes
**Note**: Log search unavailable during outage, but payment processing continues

#### Scenario 5: Complete Data Center Outage
**Impact**: All services, RabbitMQ, Elasticsearch down

**Recovery**:
1. Restore RabbitMQ from snapshot in DR site
2. Restore Elasticsearch from snapshot in DR site
3. Deploy services in DR site from CI/CD pipeline
4. Update DNS/file system mounts to DR site

**Expected Recovery Time**: 1-2 hours (if DR site pre-provisioned)

### High Availability

**Service Instances:**
- File Handler: 1 active + 1 standby (Is-Alive pattern)
- Formatters: 3+ active instances (consumer group)
- Calculation: 3+ active instances (consumer group)
- Exporter: 3+ active instances (consumer group)

**RabbitMQ:**
- Single node: Sufficient for current load, SPOF acceptable given RTO/RPO
- Future: RabbitMQ cluster (3+ nodes) with mirrored queues for higher availability

**Elasticsearch:**
- Production: 3-node cluster with replicas
- Automatic failover if node fails
- Rolling restarts without downtime

### Testing

**Backup Testing:**
- Monthly restore tests for RabbitMQ and Elasticsearch
- Verify data integrity and completeness
- Document restore procedures

**DR Drills:**
- Quarterly full DR exercise
- Simulate complete outage and recover in DR site
- Measure actual RTO vs. target
- Update runbooks based on learnings

**Chaos Engineering:**
- Randomly terminate service instances (Chaos Monkey style)
- Verify automatic recovery and no data loss
- Test during low-traffic periods initially

## Monitoring and Observability

### Monitoring Strategy

**Layers:**
1. **Infrastructure Monitoring**: Server health, disk, CPU, memory, network
2. **Application Monitoring**: Service health, processing metrics, errors
3. **Business Monitoring**: Files processed, payment amounts, fees collected
4. **User Monitoring**: N/A (no human users)

**Tools:**
- **Elasticsearch + Kibana**: Primary monitoring via logs and metrics
- **RabbitMQ Management UI**: Queue depths, message rates, consumer status
- **Prometheus + Grafana** (optional): Time-series metrics and alerts
- **PagerDuty / Opsgenie**: Alerting and incident management

### Key Metrics

**System Health Metrics:**
| Metric               | Description                        | Threshold                      | Alert Level            |
| -------------------- | ---------------------------------- | ------------------------------ | ---------------------- |
| Service Availability | % uptime per service               | < 99.9%                        | Critical               |
| End-to-End Latency   | Time from file ingestion to export | > 5 min                        | Warning                |
| Error Rate           | % of failed file processing        | > 2%                           | Warning, > 5% Critical |
| Queue Depth          | Messages waiting in each queue     | > 500 Warning, > 1000 Critical | Warning/Critical       |

**Infrastructure Metrics:**
| Metric            | Description                    | Threshold       | Alert Level |
| ----------------- | ------------------------------ | --------------- | ----------- |
| CPU Usage         | Per service instance           | > 80% sustained | Warning     |
| Memory Usage      | Per service instance           | > 85%           | Warning     |
| Disk Usage        | File systems and Elasticsearch | > 90%           | Critical    |
| Network Bandwidth | Saturation                     | > 80%           | Warning     |

**Application Metrics:**
| Metric                  | Description          | Target                    |
| ----------------------- | -------------------- | ------------------------- |
| Files Processed/Minute  | Throughput           | ~0.35 files/min (500/day) |
| Processing Success Rate | % successful         | > 99%                     |
| Formatter Distribution  | % by format          | Track trend               |
| Calculation Time        | Avg time per file    | < 10 seconds              |
| Export Success Rate     | % delivered to banks | > 99.9%                   |

**Business Metrics:**
| Metric                   | Description     | Use Case           |
| ------------------------ | --------------- | ------------------ |
| Total Payment Amount     | Daily sum       | Business reporting |
| Total Fees Collected     | Calculated fees | Revenue tracking   |
| Payment Count by Bank    | Distribution    | Capacity planning  |
| Average Transaction Size | Mean amount     | Trend analysis     |

### Alerting

**Alert Configuration:**

**Critical (Page Immediately):**
- Any service completely down (no logs for 5 minutes)
- Error rate > 5%
- Queue depth > 1000 messages for > 10 minutes
- RabbitMQ or Elasticsearch cluster down
- Disk space < 5% remaining
- Any message in dead letter queue
- File Handler failover event (standby became active)

**Warning (Notify During Business Hours):**
- Error rate > 2%
- Processing latency > 2 minutes (average)
- Queue depth > 500 messages
- CPU or memory > 80% for > 15 minutes
- Elasticsearch cluster health: Yellow
- Backup failure

**Info (Dashboard Only, Daily Digest Email):**
- Daily processing summary (files, amounts, errors)
- New file format detected
- Configuration changes
- Successful deployments
- Scheduled maintenance notifications

**Alert Channels:**
- **Critical**: PagerDuty → SMS/Phone + Slack #incidents + Email
- **Warning**: Slack #monitoring + Email
- **Info**: Email daily digest

**Alert Policies:**
- Acknowledge within 15 minutes for Critical
- Resolve within 1 hour for Critical
- On-call rotation: Primary and secondary engineer
- Escalation after 30 minutes if not acknowledged

### Logging

**Log Levels:**
- **ERROR**: Processing failures, exceptions, invalid data
- **WARN**: Unusual conditions, retry attempts, performance degradation
- **INFO**: Significant events (file processed, queue published, export completed)
- **DEBUG**: Detailed processing steps (non-production)

**Structured Logging (JSON):**
```json
{
  "@timestamp": "2026-01-08T10:30:00.123Z",
  "level": "INFO",
  "service": "file-formatters",
  "instance": "formatter-2",
  "correlationId": "abc123-def456-789",
  "messageTemplate": "File formatted successfully",
  "message": "File formatted successfully: payment_001.csv",
  "fields": {
    "fileId": "uuid",
    "fileName": "payment_001.csv",
    "sourceFormat": "CSV",
    "paymentCount": 150,
    "processingTimeMs": 234
  }
}
```

**Correlation IDs:**
- Generate unique correlation ID when file is ingested
- Pass correlation ID through all pipeline stages via message metadata
- Include in all logs for that file
- Enables end-to-end tracing of individual file through pipeline

**Log Storage & Retention:**
- Elasticsearch with Index Lifecycle Management
- Hot (0-7 days): Fast SSD, actively indexed
- Warm (7-90 days): Slower storage, read-only
- Cold (90 days - 7 years): Archive storage, rarely accessed
- Delete (> 7 years): Automatic deletion

### Kibana Dashboards

**Operations Dashboard:**
- Current Files Processed (gauge)
- Files Processing Rate (line chart, last hour)
- Queue Depths (horizontal bar chart)
- Error Count by Service (stacked bar chart)
- Active Service Instances (status grid)
- Recent Errors (data table with drill-down)

**Performance Dashboard:**
- End-to-End Processing Latency (histogram)
- Processing Time by Stage (stacked area chart)
- Queue Lag Over Time (line chart)
- Throughput by Hour (heatmap)
- 95th/99th Percentile Latencies (line chart)

**Error Analysis Dashboard:**
- Error Rate Over Time (line chart with threshold lines)
- Error Types Distribution (pie chart)
- Top Error Messages (word cloud or table)
- Errors by Service (bar chart)
- Failed Files List (data table with filters)
- Dead Letter Queue Messages (table with reprocess button)

**Business Analytics Dashboard:**
- Daily Payment Volume (bar chart by date)
- Total Amount Processed (line chart trend)
- Payment Distribution by Currency (pie chart)
- Fees Collected (line chart)
- Format Distribution (donut chart)
- Payments by Bank (horizontal bar chart)

### Distributed Tracing

**Tracing Strategy:**
- Use correlation IDs to trace individual file through pipeline
- Log correlation ID at every stage
- Kibana search by correlation ID shows complete journey

**Trace Example:**
```
CorrelationId: abc123-def456-789
├─ 10:29:00.000 [File Handler] File detected: payment_001.csv
├─ 10:29:00.500 [File Handler] File published to Files Queue
├─ 10:29:01.000 [File Formatters] File consumed from Files Queue
├─ 10:29:01.234 [File Formatters] File formatted successfully (CSV→JSON)
├─ 10:29:01.500 [File Formatters] Published to Formatted Files Queue
├─ 10:29:02.000 [File Calculation] File consumed from Formatted Files Queue
├─ 10:29:02.150 [File Calculation] Calculations completed
├─ 10:29:02.300 [File Calculation] Published to Calculated Files Queue
├─ 10:29:03.000 [File Exporter] File consumed from Calculated Files Queue
├─ 10:29:03.450 [File Exporter] Bank file generated (NACHA format)
└─ 10:29:03.500 [File Exporter] File written to bank folder: /output/bank1/batch_001.ach
```

**Advanced Tracing (Future Enhancement):**
- Consider OpenTelemetry or Jaeger for distributed tracing
- Add instrumentation to measure time spent in each stage
- Visualize traces in Jaeger UI or Grafana
- Identify bottlenecks and optimization opportunities

## Deployment Architecture

### Environments

**Development:**
- Purpose: Developer local and shared dev environment
- Infrastructure: Docker Compose on single machine or lightweight cloud VMs
- Services: All services with 1 instance each
- RabbitMQ: Single node, non-persistent queues acceptable
- Elasticsearch: Single node, minimal retention (7 days)
- Data: Synthetic test payment files

**Testing/QA:**
- Purpose: Integration testing, QA validation, performance testing
- Infrastructure: Kubernetes cluster or VMs
- Services: All services with 2 instances each (test redundancy)
- RabbitMQ: Single node, persistent queues
- Elasticsearch: Single node, 30-day retention
- Data: Anonymized production data or comprehensive test dataset

**Staging:**
- Purpose: Pre-production validation, final testing before release
- Infrastructure: Identical to production
- Services: Same instance count as production
- RabbitMQ: Same configuration as production
- Elasticsearch: 3-node cluster, full retention
- Data: Anonymized production data, replayed production load

**Production:**
- Purpose: Live payment processing
- Infrastructure: Production-grade (HA, monitoring, backups)
- Services: File Handler (1 active + 1 standby), Formatters/Calculation/Exporter (3+ instances each)
- RabbitMQ: Single node (sufficient) or 3-node cluster (HA)
- Elasticsearch: 3-node cluster, 7-year retention
- Data: Real payment files

### CI/CD Pipeline

**Source Control:**
- Git repository (GitHub, GitLab, Azure DevOps)
- Branching strategy: GitFlow or trunk-based development
- Feature branches for development
- Pull requests with code review required
- Main/master branch protected, deploy-only

**Continuous Integration:**
1. Developer pushes code to feature branch
2. CI pipeline triggers on push:
   - Restore dependencies
   - Build solution
   - Run unit tests
   - Run integration tests (with test containers for RabbitMQ)
   - Code quality checks (SonarQube, linters)
   - Security scanning (SAST, dependency vulnerabilities)
   - Build Docker images
   - Publish artifacts to container registry
3. If all checks pass, mark build as successful
4. If checks fail, notify developer, block merge

**Continuous Deployment:**
1. Merge feature branch to main (after PR approval)
2. CD pipeline triggers on main branch:
   - Build and tag Docker images (with version tag)
   - Push images to container registry
   - Deploy to Development environment (automatic)
3. Run smoke tests in Development
4. If smoke tests pass, deployment to Testing available (manual trigger or automatic)
5. Run integration tests in Testing
6. Deployment to Staging available (manual approval required)
7. Run full test suite in Staging
8. Deployment to Production available (manual approval required, change control)
9. Deploy to Production using blue-green or canary strategy
10. Run smoke tests in Production
11. Monitor for errors, rollback if issues detected

**Deployment Strategy for Production:**

**Blue-Green Deployment:**
- Maintain two identical production environments: Blue (current) and Green (new)
- Deploy new version to Green environment
- Route small percentage of traffic to Green (smoke test)
- If successful, switch all traffic to Green
- Keep Blue as rollback option for 24 hours

**Canary Deployment (Alternative):**
- Deploy new version to subset of instances (e.g., 1 out of 5)
- Monitor error rates and performance
- Gradually increase canary instances if healthy
- Rollback if error rate increases

**Database Migrations:**
- N/A (no application database)
- Schema-less messaging (JSON in queues)
- Backward-compatible message format changes

**Configuration Management:**
- Configuration stored in environment variables or config maps (Kubernetes)
- Secrets stored in Azure Key Vault or Kubernetes Secrets
- Different configurations per environment

### Infrastructure as Code

**Tools:**
- **Terraform**: Provision cloud infrastructure (VMs, networks, storage)
- **Ansible**: Configure servers, install dependencies
- **Kubernetes Manifests**: Deploy services in Kubernetes
- **Helm Charts**: Package Kubernetes applications

**Version Control:**
- Infrastructure code stored in Git repository
- Separate repo or mono-repo with application code
- CI/CD pipeline for infrastructure changes (plan, review, apply)

**Example Structure:**
```
infrastructure/
├── terraform/
│   ├── environments/
│   │   ├── dev/
│   │   ├── staging/
│   │   └── production/
│   ├── modules/
│   │   ├── rabbitmq/
│   │   ├── elasticsearch/
│   │   └── compute/
│   └── main.tf
├── ansible/
│   ├── playbooks/
│   └── roles/
└── kubernetes/
    ├── base/
    ├── overlays/
    │   ├── dev/
    │   ├── staging/
    │   └── production/
    └── helm-charts/
```

### Containerization

**Container Strategy:**
- All .NET services containerized with Docker
- Base image: `mcr.microsoft.com/dotnet/aspnet:8.0` or `mcr.microsoft.com/dotnet/runtime:8.0`
- Multi-stage builds for smaller images
- Image scanning for vulnerabilities (Trivy, Clair)

**Example Dockerfile:**
```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["FileHandler/FileHandler.csproj", "FileHandler/"]
RUN dotnet restore "FileHandler/FileHandler.csproj"
COPY . .
WORKDIR "/src/FileHandler"
RUN dotnet build "FileHandler.csproj" -c Release -o /app/build

FROM build AS publish
RUN dotnet publish "FileHandler.csproj" -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "FileHandler.dll"]
```

**Container Registry:**
- Docker Hub, Azure Container Registry, or AWS ECR
- Images tagged with version (e.g., `payrawl/file-handler:1.2.3`)
- Latest tag for convenience (not for production)

**Orchestration:**
- **Kubernetes** (recommended for production)
- Docker Compose (dev environment)
- Docker Swarm (alternative)

**Resource Limits (Kubernetes):**
```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "250m"
  limits:
    memory: "512Mi"
    cpu: "500m"
```

## Performance Optimization

### Caching Strategy

**Application-Level Caching:**
- **Exchange Rates**: Cache daily exchange rates in-memory
  - TTL: 24 hours
  - Refresh at midnight
  - Fallback to previous day if API unavailable

- **Business Rules**: Cache calculation rules in-memory
  - TTL: Load at startup, refresh on configuration change
  - Avoids repeated parsing or database lookups

**RabbitMQ Optimization:**
- Tune prefetch count: 5-10 messages per consumer
- Balance between throughput and fair distribution
- Too high: One fast consumer hogs all messages
- Too low: Consumers idle waiting for next message

### Queue Optimization

**Message Size:**
- Keep messages reasonably small (< 5 MB)
- For large files, consider storing in shared storage and passing reference
- Reduces network overhead and memory usage

**Batch Processing:**
- Current design processes files individually
- Future enhancement: Batch multiple small files into single message
- Reduces queue overhead, improves throughput

**Parallel Processing:**
- Consumer groups enable parallel processing naturally
- Scale instances based on load

### File I/O Optimization

**File Reading:**
- Use buffered streams for efficient reading
- Read files asynchronously (`FileStream` with `async/await`)
- Minimize file handle duration (open, read, close quickly)

**File Writing:**
- Write to temporary file first, then rename atomically
- Prevents partial files if process crashes mid-write
- Use buffered writes for efficiency

**File System:**
- Use fast storage (SSD) for source and bank folders
- Consider network file systems (NFS, SMB) for centralized storage
- Monitor I/O wait times

### .NET Performance:**
- Use `Span<T>` and `Memory<T>` for efficient memory management
- Avoid unnecessary allocations (object pooling for reusable objects)
- Use `async/await` consistently to avoid thread pool starvation
- Profile with dotnet-trace, PerfView, or Application Insights

## Testing Strategy

### Test Levels

**Unit Tests:**
- Coverage Target: 80% code coverage
- Tools: xUnit, NUnit, Moq (mocking)
- Scope:
  - Formatter logic (CSV, XML, JSON parsing)
  - Calculation rules (fee calculations, validations)
  - Template generators (bank file format generation)
  - Business logic in isolation
- Execution: Every build in CI pipeline

**Integration Tests:**
- Scope:
  - RabbitMQ integration (publish, consume, acknowledge)
  - File system operations (read, write, watch)
  - Elasticsearch logging integration
  - End-to-end formatter tests (input file → standardized output)
- Tools: xUnit with Testcontainers (Docker-based test dependencies)
- Execution: Every build in CI pipeline

**Component Tests:**
- Scope: Each service in isolation with real dependencies (RabbitMQ, Elasticsearch)
- Test full service behavior:
  - File Handler: Detects file, publishes to queue
  - Formatters: Consumes, formats, publishes
  - Calculation: Consumes, calculates, publishes
  - Exporter: Consumes, generates file, writes to folder
- Tools: Docker Compose for test environment
- Execution: Every build in CI pipeline

**End-to-End Tests:**
- Scope: Entire pipeline from source folder to bank folder
- Scenarios:
  - Happy path: Valid CSV file processes successfully
  - Multiple formats: CSV, XML, JSON files all process
  - Error handling: Invalid file handled gracefully
  - High volume: 100 files processed in sequence
- Environment: Staging environment
- Execution: Before production deployment

**Performance Tests:**
- Load Testing:
  - Simulate 500 files/day load
  - Verify processing completes within SLA (1 min per file)
  - Tools: Custom scripts or k6
- Stress Testing:
  - Increase load to 2x, 5x, 10x normal
  - Find breaking point
  - Verify graceful degradation
- Endurance Testing:
  - Run at normal load for 24 hours
  - Check for memory leaks, resource exhaustion
  - Verify system remains stable
- Tools: Locust, JMeter, or custom .NET load generator

**Chaos Testing:**
- Randomly terminate service instances
- Simulate RabbitMQ failures
- Verify automatic recovery
- Check for data loss (should be zero)
- Tools: Chaos Mesh, Chaos Toolkit, or manual scripts

### Quality Gates

**Pre-Merge (Pull Request):**
- All unit tests pass
- Code coverage ≥ 80%
- No critical or high severity security vulnerabilities
- Code review approved by at least one other developer
- Linting and code quality checks pass (SonarQube)

**Pre-Deployment to Production:**
- All integration tests pass
- All end-to-end tests pass in Staging
- Performance tests meet SLA (< 1 min per file)
- Security scan passes (no critical vulnerabilities)
- Manual QA sign-off (for major releases)
- Change control approval

### Test Data

**Synthetic Test Files:**
- Generate test payment files in various formats
- Include edge cases: large files, many payments, special characters
- Invalid files for error testing

**Anonymized Production Data:**
- Use in Testing and Staging for realistic testing
- Scrub PII (replace account numbers, names with fake data)
- Retain file structure and characteristics

## Cost Analysis

### Infrastructure Costs (Estimated Monthly)

**Compute (Cloud or On-Premise):**
- File Handler: 2 instances × $50/month = $100
- File Formatters: 3 instances × $50/month = $150
- File Calculation: 3 instances × $50/month = $150
- File Exporter: 3 instances × $50/month = $150
- **Total Compute**: $550/month

**RabbitMQ:**
- Single node VM: $100/month
- (Or managed service: $200-500/month)
- **Total RabbitMQ**: $100/month

**Elasticsearch:**
- 3-node cluster: 3 × $150/month = $450
- (Or managed service like Elastic Cloud: $500-1000/month)
- **Total Elasticsearch**: $450/month

**Storage:**
- Payment files (180 GB/year): ~$5/month (standard storage)
- Elasticsearch logs (640 GB/7 years with compression): ~$100/month (tiered storage)
- Backups (snapshots): ~$50/month
- **Total Storage**: $155/month

**Network:**
- Data transfer (internal): Minimal
- **Total Network**: $20/month

**Monitoring & Tooling:**
- PagerDuty or equivalent: $50/month
- (Prometheus+Grafana self-hosted: $0)
- **Total Tooling**: $50/month

**Total Estimated Monthly Cost**: **~$1,325/month** (self-managed) or **~$2,000/month** (with managed services)

**Annual Cost**: ~$16,000 - $24,000

### Cost Optimization

**Strategies:**
- Use reserved instances or savings plans for predictable workloads (30-50% savings)
- Auto-scale services during off-peak hours (nights, weekends)
- Use Elasticsearch ILM to move old data to cheaper storage tiers
- Compress logs aggressively in cold storage
- Consider spot/preemptible instances for non-critical environments (dev/test)

**Cost vs. Benefits:**
- Processing 500 files/day = 15,000 files/month
- Cost per file: ~$0.09 - $0.13 per file
- Enables automated, reliable, scalable payment processing
- Eliminates manual processing costs (likely much higher)
- Provides audit compliance, reducing regulatory risk

## Risks and Mitigation

| Risk                                       | Likelihood | Impact   | Mitigation Strategy                                                                                                   | Owner           |
| ------------------------------------------ | ---------- | -------- | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| **Data Loss due to Que Failure**           | Low        | Critical | - RabbitMQ persistent queues<br>- Durable messages<br>- Manual acknowledgment<br>- Regular backups                    | Platform Team   |
| **Processing Bottleneck under High Load**  | Medium     | High     | - Horizontal scaling with consumer groups<br>- Monitor queue depth<br>- Auto-scaling policies<br>- Load testing       | DevOps Team     |
| **Invalid File Formats Blocking Pipeline** | Medium     | Medium   | - Robust error handling<br>- Dead letter queues<br>- Validation at each stage<br>- Alerting on DLQ messages           | Dev Team        |
| **Elasticsearch Storage Exhaustion**       | Medium     | Medium   | - Index Lifecycle Management<br>- Storage monitoring and alerts<br>- Automatic data deletion after 7 years            | Platform Team   |
| **Security Breach (Unauthorized Access)**  | Low        | Critical | - Encryption at rest and in transit<br>- Strong authentication<br>- Network segmentation<br>- Regular security audits | Security Team   |
| **Dependency on Single RabbitMQ Node**     | Medium     | High     | - RabbitMQ clustering (future)<br>- Fast failover procedures<br>- Regular backups                                     | Platform Team   |
| **Bank Folder Unavailability**             | Low        | High     | - Retry logic with exponential backoff<br>- Alerts on write failures<br>- DLQ for persistent failures                 | DevOps Team     |
| **New File Format Requires Formatter**     | Medium     | Low      | - Pluggable formatter architecture<br>- Quick development and deployment<br>- Documentation for adding formatters     | Dev Team        |
| **Log Storage Costs Exceed Budget**        | Low        | Medium   | - Aggressive compression<br>- ILM for tiered storage<br>- Sampling for DEBUG logs                                     | Platform Team   |
| **Regulatory Compliance Failure**          | Low        | Critical | - 7-year log retention policy<br>- Audit logging for all operations<br>- Regular compliance reviews                   | Compliance Team |

## Future Enhancements

### Phase 1 (Current - Year 1)
**Focus**: Establish stable, reliable payment processing pipeline

**Features:**
- File Handler, Formatters, Calculation, Exporter services
- RabbitMQ message queuing
- Elastic Stack logging
- Basic monitoring and alerting
- Manual scaling (operator adds/removes instances)

### Phase 2 (Year 1-2)
**Focus**: Enhanced observability and automation

**Enhancements:**
1. **Advanced Monitoring**:
   - Distributed tracing with OpenTelemetry or Jaeger
   - Custom Grafana dashboards with Prometheus metrics
   - Business intelligence dashboards in Kibana

2. **Auto-Scaling**:
   - Kubernetes Horizontal Pod Autoscaler (HPA) based on queue depth
   - Scale services automatically during peak hours
   - Cost optimization by scaling down during off-peak

3. **Improved Error Handling**:
   - Automated reprocessing of DLQ messages (after fixing issues)
   - Machine learning for error pattern detection
   - Self-healing capabilities for common issues

4. **Additional File Formats**:
   - SWIFT MT940, MT942 formatters
   - ISO 20022 camt.053, camt.054
   - Bank-specific proprietary formats

### Phase 3 (Year 2-3)
**Focus**: Advanced features and scalability

**Strategic Initiatives:**
1. **Real-Time Processing**:
   - Reduce processing latency from minutes to seconds
   - Prioritize urgent payments
   - Real-time monitoring dashboards

2. **Multi-Region Deployment**:
   - Deploy in multiple geographic regions
   - Disaster recovery across regions
   - Regulatory compliance (data residency)

3. **Advanced Analytics**:
   - Predictive analytics for payment volumes
   - Anomaly detection for fraud prevention
   - Cost optimization recommendations

4. **API Layer** (Optional):
   - REST API for programmatic file submission (alternative to file system)
   - Webhook notifications for payment status
   - Query API for payment status lookup

### Technical Debt

**Known Issues:**
- Single RabbitMQ node is SPOF (plan for clustering)
- File Handler Is-Alive mechanism requires shared storage (consider etcd/Consul)
- No automated rollback in CD pipeline (manual intervention required)
- Limited metrics on business operations (extend instrumentation)

**Refactoring Needs:**
- Standardize error handling across all services
- Extract common queue publishing logic to shared library
- Improve test coverage for edge cases
- Document architecture decision records (ADRs)

## Appendices

### Appendix A: Glossary

| Term                        | Definition                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------- |
| **ACH**                     | Automated Clearing House - Electronic payment network in the US                        |
| **Consumer Group**          | Pattern where multiple instances consume from same queue with automatic load balancing |
| **Dead Letter Queue (DLQ)** | Queue for messages that failed processing after retries                                |
| **Durable Queue**           | Queue that survives broker restart (persisted to disk)                                 |
| **ILM**                     | Index Lifecycle Management - Elasticsearch feature for data retention automation       |
| **Is-Alive Mechanism**      | Active-standby pattern with heartbeat monitoring for failover                          |
| **NACHA**                   | National Automated Clearing House Association - ACH file format standard               |
| **Persistent Message**      | Message written to disk to survive broker restart                                      |
| **RPO**                     | Recovery Point Objective - Maximum acceptable data loss duration                       |
| **RTO**                     | Recovery Time Objective - Maximum acceptable downtime duration                         |
| **SWIFT**                   | Society for Worldwide Interbank Financial Telecommunication - Messaging network        |
| **ISO 20022**               | International standard for financial messaging                                         |

### Appendix B: References

- [RabbitMQ Documentation](https://www.rabbitmq.com/documentation.html)
- [Elastic Stack Documentation](https://www.elastic.co/guide/index.html)
- [.NET Documentation](https://docs.microsoft.com/en-us/dotnet/)
- [NACHA File Format Specification](https://www.nacha.org/)
- [SWIFT MT103 Specification](https://www.swift.com/)
- [ISO 20022 Standard](https://www.iso20022.org/)

### Appendix C: Decision Log

| Date       | Decision                                                   | Rationale                                         | Decision Maker    |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------- | ----------------- |
| 2026-01-01 | Use RabbitMQ for message queuing                           | Appropriate scale, ease of use, durable messaging | Architecture Team |
| 2026-01-01 | Use .NET Core for all services                             | Performance, productivity, cross-platform         | Architecture Team |
| 2026-01-01 | Use Elastic Stack for logging                              | Purpose-built for logs, proven at scale           | Architecture Team |
| 2026-01-01 | Consumer Group pattern for Formatters/Calculation/Exporter | Automatic load balancing, horizontal scaling      | Architecture Team |
| 2026-01-01 | Is-Alive pattern for File Handler                          | Prevent duplicate file ingestion                  | Architecture Team |
| 2026-01-01 | No application database                                    | Stateless pipeline, state in messages only        | Architecture Team |

### Appendix D: Team and Contacts

**Architecture Team:**
- Chief Architect: [Name] - [Email]
- Solution Architect: [Name] - [Email]

**Development Team:**
- Dev Lead: [Name] - [Email]
- .NET Developers: [Names] - [Emails]

**DevOps Team:**
- DevOps Lead: [Name] - [Email]
- Platform Engineers: [Names] - [Emails]

**Operations Team:**
- Operations Manager: [Name] - [Email]
- On-Call Engineers: [Names] - [Emails]

**Security Team:**
- Security Lead: [Name] - [Email]

---

## Document Control

**Version History:**

| Version | Date       | Author            | Changes                                     |
| ------- | ---------- | ----------------- | ------------------------------------------- |
| 1.0     | 2026-01-08 | Architecture Team | Initial comprehensive architecture document |

**Review Schedule:**
- This document should be reviewed: Quarterly or after major architectural changes
- Next review date: 2026-04-08

**Approval:**

| Role                | Name   | Signature | Date |
| ------------------- | ------ | --------- | ---- |
| Chief Architect     | [Name] |           |      |
| Engineering Manager | [Name] |           |      |
| Product Owner       | [Name] |           |      |
| CTO                 | [Name] |           |      |

---

**Document Status**: Approved
**Last Updated**: 2026-01-08
**Author**: PayRawl Architecture Team
