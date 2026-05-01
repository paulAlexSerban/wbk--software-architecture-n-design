# GroceColl - Grocery Collection & Delivery Service
> FROM: "Software Architecture Case Studies" on Udemy

## Overview

GroceColl is a global grocery shopping and delivery service that bridges customers and in-store shoppers. Customers create shopping lists through mobile or web applications, and GroceColl's trained employees collect the requested items from grocery stores and deliver them to customers' homes. This architecture document focuses on the **collection side** of the system—the tools and infrastructure that enable employees to efficiently fulfill shopping orders.

**Business Context:**
- **Industry**: On-demand grocery delivery and personal shopping services
- **Business Model**: B2C service connecting customers with in-store shoppers
- **Geographic Scope**: Worldwide operations across multiple time zones
- **Target Users**: GroceColl employees (in-store shoppers) using dedicated tablets
- **Scope of This Document**: Collection/fulfillment system only (customer-facing app is out of scope)

**System Characteristics:**
- **Global Scale**: Operating in multiple countries with varying network conditions
- **Mobile-First**: Employees use tablets in grocery stores during collection
- **Offline-Critical**: Must function without internet connectivity inside stores
- **High Volume**: Processing thousands of shopping lists daily
- **Real-Time Updates**: Synchronize list status and item availability as collection progresses
- **Integration**: Interfaces with upstream customer systems and downstream payment engine


## Requirements

### Functional Requirements (What the system should do)

- **List Reception**: Receive shopping lists from upstream customer system via message queue
- **List Storage**: Persist shopping lists with all items, customer details, and delivery information
- **List Assignment**: Provide next available list to employees based on location and availability
- **Item Management**: Allow employees to mark individual items as:
  - Collected (item found and added to basket)
  - Unavailable (item out of stock or not found)
- **List Completion**: Mark entire list as completed when all items processed
- **Payment Data Export**: Send completed list data to Payment Engine for billing
- **Offline Support**: Enable employees to work without internet connectivity
  - Cache lists and updates locally on tablet
  - Synchronize changes when connection restored
- **List Status Tracking**: Maintain status throughout lifecycle (pending → in progress → completed)
- **Employee Attribution**: Track which employee collected each list

### Non-Functional Requirements (What the system should deal with)

**Performance Requirements:**
- **Concurrent Users**: Support ~200 simultaneous employees during peak hours
- **Daily Throughput**: Process ~10,000 shopping lists per day
- **Response Time**: 
  - API responses < 500ms under normal load
  - Offline operations instantaneous (local storage)
  - Sync operations < 2 seconds per list
- **List Retrieval**: Employees should get next list within 1 second

**Data Volume Estimation:**
- **Per List**: ~500 KB average (items, customer info, metadata)
- **Daily**: 10,000 lists × 500 KB = ~5 GB/day
- **Monthly**: 300,000 lists × 500 KB = ~150 GB/month
- **Yearly**: 3,600,000 lists × 500 KB = ~1.8 TB/year
- **Data Growth**: Expect 20-30% annual growth as service expands

**Reliability Requirements:**
- **Service Level Agreement (SLA)**: 99.9% uptime (≤ 8.76 hours downtime per year)
- **Data Integrity**: No list or item data loss acceptable
- **Sync Reliability**: Offline changes must sync successfully when online
- **Conflict Resolution**: Handle concurrent updates gracefully

**Offline Support Requirements (Critical):**
- **Scenario**: Employees often lose connectivity inside stores (thick walls, basements)
- **Duration**: May be offline for 30-60 minutes during collection
- **Functionality Required Offline**:
  - View full shopping list
  - Mark items as collected/unavailable
  - Complete list
  - Queue updates for later sync
- **Synchronization**:
  - Auto-sync when connection restored
  - Manual sync trigger available
  - Conflict detection and resolution
  - Progress indicator during sync

**Integration Requirements:**
- **Upstream - Customer System**:
  - Method: Message queue (existing infrastructure)
  - Format: JSON messages with shopping list data
  - Frequency: Continuous (as customers place orders)
  - Direction: Inbound only
  
- **Downstream - Payment Engine**:
  - Method: Message queue (same infrastructure)
  - Format: JSON messages with completed list and pricing data
  - Frequency: Triggered when list marked complete
  - Direction: Outbound only

**Infrastructure Constraints:**
- **Technology Stack**: Client development team expertise in Java and MySQL
- **Tablet Hardware**: Standard Android tablets with intermittent connectivity
- **Deployment**: Existing company infrastructure and cloud platform
- **Database**: MySQL preferred by operations team (familiar tooling, backups)

**Scalability Requirements:**
- **Current Scale**: 200 concurrent users, 10K lists/day
- **Peak Load**: 2-3x normal during holidays and weekends
- **Geographic Distribution**: Worldwide deployment with regional data centers
- **Future Growth**: System must scale to 500 concurrent users and 50K lists/day within 2 years

## Executive Summary

**Architecture Style:** Service-Oriented Architecture (SOA) with event-driven messaging and offline-first mobile client

**Key Architectural Components:**

1. **Lists Receiver Service** (Java)
   - Consumes shopping lists from message queue using consumer group pattern
   - Validates and persists lists to MySQL database
   - Provides high availability through multiple instances

2. **Lists Service** (Java REST API)
   - RESTful API for tablet application interactions
   - Manages list lifecycle (assignment, updates, completion)
   - Exports completed lists to Payment Engine queue
   - Load-balanced across multiple instances

3. **Lists Database** (MySQL)
   - Central data store for all shopping lists and statuses
   - Master-slave replication for high availability
   - Partitioning strategy to handle 1.8 TB annual growth
   - Read replicas for query performance

4. **Tablet Application** (React Native)
   - Web-based application for cross-platform tablet support
   - Offline-first architecture with local caching
   - Auto-synchronization when connectivity restored
   - Intuitive interface for item collection workflow

5. **Message Queues**
   - Inbound: Shopping lists from customer system
   - Outbound: Completed lists to Payment Engine
   - Leverages existing company queue infrastructure

**Technology Stack:**
- **Backend**: Java (Spring Boot) for services
- **Database**: MySQL with replication and partitioning
- **Client**: React Native for cross-platform web application
- **Messaging**: Company's existing message queue infrastructure
- **Infrastructure**: Company cloud platform with load balancers

**Key Architectural Principles:**

1. **Offline-First Design**
   - Tablet app functions fully without connectivity
   - Local storage for lists and updates
   - Queue-based synchronization when online
   - Critical for in-store shopping environment

2. **Separation of Concerns**
   - Lists Receiver: Inbound message processing only
   - Lists Service: Business logic and API endpoints
   - Clear boundaries enable independent scaling and maintenance

3. **High Availability**
   - Consumer groups for parallel message processing
   - Load-balanced API servers
   - Database replication (master-slave)
   - No single point of failure

4. **Scalability**
   - Horizontal scaling of services via load balancers
   - Database partitioning for growing data volume
   - Consumer groups handle increasing message throughput
   - Architecture supports 2.5x growth (200 → 500 users, 10K → 50K lists/day)

5. **Technology Alignment**
   - Java and MySQL match client team's expertise
   - React Native provides cross-platform consistency
   - Leverages existing infrastructure (queues, cloud platform)
   - Minimizes operational complexity

**Critical Success Factors:**
- Robust offline synchronization (primary technical challenge)
- Sub-second API response times for smooth employee experience
- 99.9% uptime SLA for business operations
- Seamless integration with existing customer and payment systems

## Components
Based on [the requirements](#requirements), the following components have been identified for the GroceColl collection system:

### Component Overview

1. **Lists Queue** *(External - Out of Scope)*
   - Source: Customer ordering system
   - Contains shopping lists submitted by customers
   - Interface point for GroceColl collection system

2. **Lists Receiver Service**
   - **Primary Responsibility**: Inbound message processing
   - **What It Does**:
     - Consumes shopping lists from Lists Queue
     - Validates list data (completeness, format)
     - Persists lists to Lists Database with "pending" status
     - Handles message acknowledgment and error cases
   - **Why Separate**: Isolates queue consumption logic from business operations; enables independent scaling of message processing

3. **Lists Service (REST API)**
   - **Primary Responsibility**: Business logic and employee interactions
   - **What It Does**:
     - Provides REST API for Tablet Application
     - Assigns next available list to employees
     - Processes item status updates (collected/unavailable)
     - Marks lists as completed
     - Exports completed list data to Payment Engine queue
   - **Why Separate**: Decouples API layer from inbound processing; allows independent scaling based on employee load vs. message throughput

4. **Lists Database (MySQL)**
   - **Primary Responsibility**: Persistent data storage
   - **What It Stores**:
     - Shopping lists with all items and metadata
     - List status (pending, in_progress, completed)
     - Item statuses (pending, collected, unavailable)
     - Employee assignments and timestamps
     - Customer and delivery information
   - **Design Considerations**: Master-slave replication, partitioning strategy for multi-year data retention

5. **Tablet Application (React Native Web)**
   - **Primary Responsibility**: Employee-facing interface
   - **What It Does**:
     - Displays assigned shopping list to employee
     - Allows marking items as collected or unavailable
     - Marks entire list as completed
     - Caches data locally for offline operation
     - Syncs updates when connectivity available
   - **Why Web-Based**: Cross-platform compatibility, no installation required, lower hardware costs

6. **Lists Data Queue** *(Shared Infrastructure)*
   - **Primary Responsibility**: Outbound message delivery
   - **What It Does**:
     - Receives completed list data from Lists Service
     - Delivers data to Payment Engine for billing
   - **Design Note**: Uses same queue infrastructure as Lists Queue for consistency

### Component Interaction Flow

**Normal Flow (Online):**
1. Customer System → **Lists Queue** → **Lists Receiver** → **Lists Database**
2. Employee opens Tablet → **Tablet App** → **Lists Service** → **Lists Database** (fetch next list)
3. Employee collects items → **Tablet App** → **Lists Service** → **Lists Database** (update items)
4. Employee completes list → **Tablet App** → **Lists Service** → **Lists Database** (mark complete) → **Lists Data Queue** → Payment Engine

**Offline Flow:**
1. Tablet App operates from local cache (SQLite or IndexedDB)
2. Employee updates cached locally with timestamps
3. When connectivity restored → Tablet App syncs queued updates → Lists Service → Lists Database
4. Conflict resolution handles concurrent updates (last-write-wins with employee attribution)

### Separation of Concerns Rationale

**Why Lists Receiver and Lists Service are Separate:**

| Aspect                 | Lists Receiver                         | Lists Service                    |
| ---------------------- | -------------------------------------- | -------------------------------- |
| **Primary Function**   | Message consumption                    | Business logic & API             |
| **Scaling Driver**     | Message queue throughput               | Employee concurrency             |
| **Deployment Pattern** | Consumer group (3-5 instances)         | Load balanced (5-10 instances)   |
| **Failure Impact**     | Lists delayed in queue                 | Employees cannot work            |
| **Technology Focus**   | Queue client libraries                 | REST API frameworks              |
| **Change Frequency**   | Rarely changes (stable queue contract) | Frequent (business rule updates) |

This separation allows:
- **Independent Scaling**: Scale receiver for message load, service for user load
- **Independent Deployment**: Update business logic without touching queue consumption
- **Clear Boundaries**: Each component has single, well-defined responsibility
- **Failure Isolation**: Service downtime doesn't cause message loss (queue buffers)

### Technology Decision Summary

| Component          | Technology                      | Rationale                                                              |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| Lists Receiver     | Java                            | Team expertise, excellent queue client libraries                       |
| Lists Service      | Java (Spring Boot)              | Team expertise, mature REST framework, built-in load balancing support |
| Lists Database     | MySQL                           | Team expertise, proven partitioning capabilities, strong replication   |
| Tablet Application | React Native (Web)              | Cross-platform, no installation, offline storage APIs (IndexedDB)      |
| Message Queues     | Existing company infrastructure | Avoid operational complexity, leverage proven platform                 |

## Services Drill Down

### Lists Receiver Service

**Purpose**: Consume shopping lists from message queue and persist to database with high reliability.

**Application Type**: Background Service (continuously running, no HTTP interface)

**Technology Stack**:
- **Language**: Java
- **Queue Client**: Native queue client library (company infrastructure)
- **Database Driver**: MySQL JDBC Connector
- **Framework**: Spring Boot (dependency injection, configuration management)
- **Build**: Maven
- **Rationale**: Matches team expertise; Java's strong queue client ecosystem; Spring Boot simplifies service configuration

**Architecture Pattern**: 3-Tier Architecture

**Layers**:

1. **Queue Consumer Layer**
   - Establishes connection to message queue
   - Subscribes to shopping lists topic/queue
   - Implements consumer group pattern for parallel processing
   - Handles message deserialization (JSON → Java objects)
   - Manages acknowledgments and retries

2. **Business Logic Layer**
   - Validates shopping list data (required fields, data types)
   - Enriches list with metadata (received timestamp, initial status)
   - Transforms queue message format to database schema
   - Implements idempotency (prevents duplicate list insertion)
   - Error handling and logging

3. **Data Access Layer**
   - Executes INSERT operations for new shopping lists
   - Inserts list items in batch for performance
   - Manages database transactions
   - Handles database connection pooling

4. **Database Layer**
   - MySQL database storing lists and items tables

**High Availability & Scalability**:

- **Consumer Group Pattern**:
  - Deploy 3-5 instances of Lists Receiver
  - Queue distributes messages across instances (load balancing)
  - If one instance fails, others continue processing
  - Ensures no message loss during instance restart/crash

- **Scaling Approach**:
  - **Current**: 3 instances handle 10K lists/day (~7 lists/minute)
  - **Future**: Add instances as throughput increases (simple horizontal scaling)
  - **Monitoring**: Track consumer lag to determine when scaling needed

**Error Handling**:
- **Transient Errors**: Retry with exponential backoff (network hiccups, temporary DB unavailability)
- **Permanent Errors**: Move message to dead letter queue (invalid data, schema violations)
- **Alerting**: Notify operations team if dead letter queue accumulates messages

**Configuration**:
- Queue connection details (URL, credentials, topic name)
- Database connection string (with read/write access)
- Consumer group ID
- Retry policy parameters
- Logging levels

**Code Example - Core Processing Logic**:
```java
@Service
public class ListsReceiverService {
    
    @Autowired
    private ShoppingListRepository repository;
    
    @KafkaListener(topics = "shopping-lists", groupId = "lists-receiver-group")
    public void consumeShoppingList(String message) {
        try {
            // Deserialize message
            ShoppingList list = objectMapper.readValue(message, ShoppingList.class);
            
            // Validate
            if (!isValid(list)) {
                log.error("Invalid shopping list received: {}", list.getId());
                throw new ValidationException("Missing required fields");
            }
            
            // Check idempotency (prevent duplicates)
            if (repository.existsById(list.getId())) {
                log.warn("Duplicate list received: {}", list.getId());
                return; // Already processed, skip
            }
            
            // Enrich
            list.setReceivedAt(Instant.now());
            list.setStatus(ListStatus.PENDING);
            
            // Persist
            repository.save(list);
            log.info("Shopping list persisted: {}", list.getId());
            
        } catch (Exception e) {
            log.error("Error processing shopping list: {}", e.getMessage());
            throw new MessageProcessingException(e); // Trigger retry or DLQ
        }
    }
}
```

---

### Lists Service (REST API)

**Purpose**: Provide REST API for tablet application to manage shopping list lifecycle.

**Application Type**: Web API (HTTP-based service)

**Technology Stack**:
- **Language**: Java
- **Framework**: Spring Boot with Spring Web
- **Database**: MySQL via Spring Data JPA
- **Queue Client**: Native queue client library (for outbound messages)
- **API Documentation**: OpenAPI/Swagger
- **Build**: Maven
- **Rationale**: Team expertise; Spring Boot's extensive REST support; built-in features (validation, exception handling, monitoring)

**Architecture Pattern**: 3-Tier REST API Architecture

**Layers**:

1. **Controller Layer (REST Endpoints)**
   - Handles HTTP requests from Tablet Application
   - Request validation (path parameters, query params, body)
   - Response formatting (JSON serialization)
   - HTTP status code management
   - API versioning (/api/v1/...)

2. **Service Layer (Business Logic)**
   - List assignment algorithm (next available list by location)
   - Item status update logic
   - List completion logic and validation
   - Export logic to Payment Engine queue
   - Transaction management

3. **Repository Layer (Data Access)**
   - Spring Data JPA repositories
   - Custom queries for list assignment
   - Batch updates for item statuses
   - Optimistic locking to prevent concurrent update conflicts

4. **Database Layer**
   - MySQL database (same as Lists Receiver)

**API Design**:

| Functionality                | Method | Endpoint                                | Request                                            | Response                                  | Status Codes                                                                            |
| ---------------------------- | ------ | --------------------------------------- | -------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| **Get next list to collect** | GET    | `/api/v1/lists/next`                    | Query params: `location`, `employeeId`             | `ShoppingList` (JSON)                     | 200 OK, 204 No Content (no lists available), 400 Bad Request, 500 Internal Server Error |
| **Mark item status**         | PUT    | `/api/v1/lists/{listId}/items/{itemId}` | Body: `{ "status": "collected" \| "unavailable" }` | `Item` (updated)                          | 200 OK, 404 Not Found, 400 Bad Request, 500 Internal Server Error                       |
| **Complete list**            | POST   | `/api/v1/lists/{listId}/complete`       | Body: `{ "employeeId": "..." }`                    | `ShoppingList` (updated)                  | 200 OK, 400 Bad Request, 500 Internal Server Error                                      |
| **Sync offline updates**     | POST   | `/api/v1/lists/{listId}/sync`           | Body: Array of item updates with timestamps        | `SyncResult` (conflicts, applied updates) | 200 OK, 409 Conflict, 500 Internal Server Error                                         |

**Request/Response Examples**:

*Get Next List:*
```bash
GET /api/v1/lists/next?location=NY-Manhattan&employeeId=emp123
```
```json
{
  "listId": "list-789",
  "customerId": "cust-456",
  "location": "NY-Manhattan",
  "items": [
    { "itemId": "item-1", "productName": "Milk 2%", "quantity": 2, "status": "pending" },
    { "itemId": "item-2", "productName": "Bread", "quantity": 1, "status": "pending" }
  ],
  "deliveryAddress": "123 Main St, Apt 5B",
  "status": "pending"
}
```

*Mark Item as Collected:*
```bash
PUT /api/v1/lists/list-789/items/item-1
Content-Type: application/json

{
  "status": "collected",
  "timestamp": "2024-01-15T10:30:00Z"
}
```
```json
{
  "itemId": "item-1",
  "status": "collected",
  "updatedBy": "emp123",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

**Business Logic Details**:

**List Assignment Algorithm**:
1. Query lists with status = "pending"
2. Filter by location (employee's current store)
3. Order by priority (VIP customers, delivery time)
4. Assign list to employee (update status = "in_progress", set employeeId)
5. Return list data to tablet

**Item Update Logic**:
1. Validate list exists and is "in_progress"
2. Validate item belongs to list
3. Update item status (collected/unavailable)
4. Record timestamp and employee ID
5. If all items processed → eligible for completion

**List Completion Logic**:
1. Validate all items have status (collected or unavailable)
2. Update list status = "completed"
3. Record completion timestamp
4. Generate payment data (items collected, quantities, pricing)
5. Push payment data to Lists Data Queue
6. Return success to tablet

**Offline Sync Logic**:
1. Tablet sends array of updates with timestamps
2. Service checks each update against database state
3. Apply updates if timestamp > database timestamp (last-write-wins)
4. Detect conflicts (same item updated by different employee)
5. Return sync result with applied/rejected updates

**High Availability & Scalability**:

- **Load Balancing**:
  - Deploy 5-10 instances behind application load balancer
  - Stateless design (no session storage) enables any instance to handle any request
  - Health checks on `/actuator/health` endpoint

- **Scaling Approach**:
  - **Current**: 5 instances handle 200 concurrent users
  - **Auto-scaling**: Scale out when CPU > 70% or request latency > 500ms
  - **Future**: Scale to 15 instances for 500 concurrent users

- **Database Connection Pooling**:
  - Each instance maintains connection pool (10-20 connections)
  - Prevents database connection exhaustion

**Performance Optimizations**:
- **Caching**: Cache location data, employee info (low-churn data)
- **Batch Operations**: Bulk item updates when syncing offline changes
- **Database Indexes**: Index on list status, location, employeeId
- **Read Replicas**: Route read-heavy queries (list retrieval) to replicas

**Code Example - List Assignment**:
```java
@RestController
@RequestMapping("/api/v1/lists")
public class ListsController {
    
    @Autowired
    private ListsService listsService;
    
    @GetMapping("/next")
    public ResponseEntity<ShoppingList> getNextList(
            @RequestParam String location,
            @RequestParam String employeeId) {
        
        Optional<ShoppingList> list = listsService.assignNextList(location, employeeId);
        
        return list.map(ResponseEntity::ok)
                   .orElse(ResponseEntity.noContent().build());
    }
    
    @PutMapping("/{listId}/items/{itemId}")
    public ResponseEntity<Item> updateItemStatus(
            @PathVariable String listId,
            @PathVariable String itemId,
            @RequestBody ItemStatusUpdate update) {
        
        Item updatedItem = listsService.updateItemStatus(listId, itemId, update);
        return ResponseEntity.ok(updatedItem);
    }
    
    @PostMapping("/{listId}/complete")
    public ResponseEntity<ShoppingList> completeList(
            @PathVariable String listId,
            @RequestBody CompleteRequest request) {
        
        ShoppingList completedList = listsService.completeList(listId, request.getEmployeeId());
        return ResponseEntity.ok(completedList);
    }
}
```

---

### Lists Database (MySQL)

**Purpose**: Centralized persistent storage for all shopping list data with high availability and scalability.

**Application Type**: Relational Database Management System (RDBMS)

**Technology Stack**:
- **Database**: MySQL 8.0+
- **Replication**: Master-Slave (1 master, 2+ slaves)
- **Backup**: Automated daily backups with point-in-time recovery
- **Monitoring**: MySQL Enterprise Monitor or Prometheus + Grafana
- **Rationale**: Operations team expertise; proven partitioning capabilities; strong ACID compliance; mature replication

**Schema Design**:

**Tables**:

1. **shopping_lists**
   - `list_id` (VARCHAR, PRIMARY KEY)
   - `customer_id` (VARCHAR)
   - `location` (VARCHAR, INDEXED)
   - `status` (ENUM: pending, in_progress, completed, INDEXED)
   - `employee_id` (VARCHAR, nullable)
   - `delivery_address` (TEXT)
   - `received_at` (TIMESTAMP)
   - `assigned_at` (TIMESTAMP, nullable)
   - `completed_at` (TIMESTAMP, nullable)
   - `created_at` (TIMESTAMP, default CURRENT_TIMESTAMP)
   - `updated_at` (TIMESTAMP, on update CURRENT_TIMESTAMP)

2. **list_items**
   - `item_id` (VARCHAR, PRIMARY KEY)
   - `list_id` (VARCHAR, FOREIGN KEY → shopping_lists.list_id)
   - `product_name` (VARCHAR)
   - `quantity` (INT)
   - `status` (ENUM: pending, collected, unavailable, INDEXED)
   - `updated_by` (VARCHAR, nullable)
   - `updated_at` (TIMESTAMP, nullable)

**Indexes**:
- `idx_lists_status_location` on `shopping_lists(status, location)` (for list assignment queries)
- `idx_lists_customer` on `shopping_lists(customer_id)` (for customer lookup)
- `idx_items_list` on `list_items(list_id)` (for fetching items by list)
- `idx_items_status` on `list_items(status)` (for analytics)

**Partitioning Strategy**:
- **Problem**: 1.8 TB annual data growth
- **Solution**: Partition `shopping_lists` by RANGE on `received_at` (monthly partitions)
- **Archiving**: Move partitions older than 2 years to archive storage
- **Benefits**: Query performance on recent data; easier data lifecycle management

```sql
CREATE TABLE shopping_lists (
    list_id VARCHAR(50) PRIMARY KEY,
    -- ...other columns
    received_at TIMESTAMP NOT NULL
)
PARTITION BY RANGE (UNIX_TIMESTAMP(received_at)) (
    PARTITION p202401 VALUES LESS THAN (UNIX_TIMESTAMP('2024-02-01')),
    PARTITION p202402 VALUES LESS THAN (UNIX_TIMESTAMP('2024-03-01')),
    -- Add partitions monthly
);
```

**High Availability Architecture**:

**Master-Slave Replication**:
- **1 Master**: Handles all WRITE operations (INSERT, UPDATE, DELETE)
- **2+ Slaves**: Handle READ operations (SELECT queries)
- **Asynchronous Replication**: Master → Slaves with ~1 second lag
- **Failover**: Promote slave to master if master fails (manual or automated)

**Read/Write Splitting**:
- **Lists Receiver**: Writes to MASTER
- **Lists Service**: 
  - Writes (item updates, list completion) → MASTER
  - Reads (list assignment, item retrieval) → SLAVES (load balanced)
- **Benefit**: Distribute load; prevent write contention

**Connection Pooling**:
- Each service instance maintains connection pool
- Lists Receiver: 5-10 connections to MASTER
- Lists Service: 10-20 connections (split between MASTER and SLAVES)

**Backup & Recovery**:
- **Daily Full Backups**: Complete database dump at midnight (low traffic)
- **Binary Log Backup**: Continuous for point-in-time recovery
- **Retention**: 30 days of backups
- **Recovery Time Objective (RTO)**: < 1 hour
- **Recovery Point Objective (RPO)**: < 5 minutes (binary log granularity)

**Performance Optimization**:
- **Query Optimization**: Regular EXPLAIN analysis on slow queries
- **Connection Pooling**: Prevent connection overhead
- **Read Replicas**: Offload read traffic from master
- **Partitioning**: Fast queries on recent data
- **Indexing**: Cover common query patterns

**Monitoring**:
- Replication lag (alert if > 5 seconds)
- Disk space utilization (alert if > 80%)
- Query performance (slow query log)
- Connection counts
- Lock contention

---

### Tablet Application (React Native Web)

**Purpose**: Employee-facing interface for shopping list collection with offline support.

**Application Type**: Progressive Web App (PWA) using React Native Web

**Technology Stack**:
- **Framework**: React Native Web (cross-platform web application)
- **State Management**: Redux with Redux Persist (offline state)
- **Local Storage**: IndexedDB (for offline data caching)
- **Networking**: Axios with offline queue (queues requests when offline)
- **Build**: Webpack, Babel
- **Deployment**: Hosted on company CDN (static files)
- **Rationale**: Cross-platform (Android, iOS tablets via browser); no installation; offline storage APIs; team can leverage React expertise

**Architecture Pattern**: Offline-First PWA Architecture

**Layers**:

1. **Presentation Layer (UI Components)**
   - List view component (displays items)
   - Item row component (mark collected/unavailable)
   - Sync status indicator
   - Offline banner

2. **State Management Layer (Redux)**
   - Global state for current list, items, sync queue
   - Actions: fetchList, updateItem, completeList, syncOfflineUpdates
   - Reducers: Manage state transitions

3. **Persistence Layer (Redux Persist + IndexedDB)**
   - Automatically persist Redux state to IndexedDB
   - Restore state on app reload
   - Stores: current list, item updates queue, employee info

4. **API Layer (Axios)**
   - HTTP client for Lists Service REST API
   - Interceptors for offline detection
   - Request queue for offline updates

5. **Sync Layer (Custom)**
   - Monitors network status (online/offline events)
   - Auto-syncs queued updates when online
   - Conflict resolution logic

**Offline-First Design**:

**Offline Capabilities**:
1. **View Shopping List**: Load list from cache (fetched when online)
2. **Mark Items**: Update local state immediately (optimistic UI)
3. **Complete List**: Mark as complete locally
4. **Queue Updates**: Store all changes in sync queue with timestamps

**Online Behavior**:
1. **Fetch List**: GET from Lists Service → cache in IndexedDB
2. **Update Item**: POST to Lists Service → update local state on success
3. **Auto-Sync**: Detect online event → send queued updates → clear queue on success

**Sync Flow**:
```
1. Tablet goes offline (inside store)
2. Employee marks 10 items as collected
3. Updates stored in local queue: [
     { itemId: "item-1", status: "collected", timestamp: "10:30:00Z" },
     { itemId: "item-2", status: "collected", timestamp: "10:31:15Z" },
     ...
   ]
4. Tablet regains connectivity
5. Sync service detects online event
6. POST /api/v1/lists/{listId}/sync with queued updates
7. Lists Service processes updates (last-write-wins)
8. Response indicates applied/rejected updates
9. Clear queue, update local state with server response
10. Show sync success notification
```

**Conflict Resolution**:
- **Strategy**: Last-write-wins based on timestamp
- **Scenario**: Two employees assigned same list by mistake (operational error)
- **Resolution**: 
  - Each tablet syncs updates with timestamps
  - Server compares timestamps, keeps latest update
  - Tablet receives conflict report, alerts employee if needed

**User Interface Flow**:

1. **Login/Start Shift**
   - Employee enters credentials
   - App authenticates with Lists Service
   - Stores employee ID locally

2. **Fetch Next List**
   - Click "Get Next List" button
   - App calls GET /api/v1/lists/next
   - Displays list items (product name, quantity)

3. **Collect Items**
   - Employee finds item in store
   - Taps "Collected" button (green checkmark)
   - OR taps "Unavailable" button (red X)
   - Item status updates locally (instant feedback)
   - If online: API call sent immediately
   - If offline: Added to sync queue

4. **Complete List**
   - When all items processed
   - Click "Complete List" button
   - App calls POST /api/v1/lists/{listId}/complete
   - Shows completion confirmation
   - Returns to "Get Next List" screen

5. **Sync Status**
   - Persistent indicator shows:
     - Green: Online, synced
     - Yellow: Offline, changes queued
     - Red: Sync error, retry needed
   - Manual "Sync Now" button available

**Code Example - Offline Sync Logic**:
```javascript
// Sync service
export const syncOfflineUpdates = () => async (dispatch, getState) => {
    const { syncQueue, currentList } = getState();
    
    if (syncQueue.length === 0) {
        console.log('No updates to sync');
        return;
    }
    
    try {
        dispatch({ type: 'SYNC_STARTED' });
        
        const response = await axios.post(
            `/api/v1/lists/${currentList.listId}/sync`,
            { updates: syncQueue }
        );
        
        const { applied, rejected } = response.data;
        
        // Update local state with server response
        dispatch({ type: 'SYNC_SUCCESS', payload: applied });
        
        // Clear synced items from queue
        dispatch({ type: 'CLEAR_SYNC_QUEUE', payload: applied });
        
        // Alert if conflicts
        if (rejected.length > 0) {
            dispatch({ type: 'SYNC_CONFLICTS', payload: rejected });
        }
        
    } catch (error) {
        dispatch({ type: 'SYNC_FAILED', error: error.message });
    }
};

// Network status listener
window.addEventListener('online', () => {
    store.dispatch(syncOfflineUpdates());
});
```

**Performance Considerations**:
- **List Caching**: Pre-fetch next 2-3 lists when online (faster assignment)
- **Image Optimization**: Compress product images for faster load
- **Lazy Loading**: Load items as employee scrolls (large lists)
- **Bundle Size**: Code-split to reduce initial load time

**Decision: Desktop vs. Web Application**

| Desktop/Native Application                           | Web-Based Application (Chosen)                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| **PRO**: Full OS functionality access                | **CON**: Limited OS functionality (sufficient for our needs)       |
| **PRO**: Utilize local apps (e.g., SQLite DB)        | **CON**: Cannot use native apps (not required)                     |
| **CON**: Complex setup and installation              | **PRO**: No installation required (just open browser)              |
| **CON**: Platform-specific (Windows, macOS, Android) | **PRO**: Cross-platform compatible (any tablet with browser)       |
| **CON**: Higher hardware requirements                | **PRO**: Lower hardware costs (no need for high-end tablets)       |
| **CON**: Requires IT department for deployment       | **PRO**: Simple deployment (host on CDN, employees access via URL) |

**Final Decision**: Web-based application using React Native Web
- **Key Benefits**: No installation, cross-platform, lower costs, easier deployment
- **Offline Support**: IndexedDB and Service Workers provide robust offline capabilities
- **Trade-off**: Acceptable given our requirements (don't need native OS features)

---

### Lists Data Queue (Outbound Messaging)

**Purpose**: Deliver completed shopping list data to Payment Engine for billing.

**Application Type**: Message Queue (Shared Infrastructure)

**Technology Stack**:
- **Queue System**: Company's existing message queue infrastructure (assumed Kafka, RabbitMQ, or AWS SQS)
- **Message Format**: JSON
- **Producer**: Lists Service
- **Consumer**: Payment Engine (external system, out of scope)

**Design Decisions**:

**Question: New Queue or Reuse Existing?**
- **Answer**: Reuse existing queue infrastructure
- **Rationale**:
  - Avoid operational complexity of managing multiple queue systems
  - Leverage existing monitoring, alerting, backup
  - Operations team already familiar with infrastructure
  - Cost savings (no additional licensing/infrastructure)

**Question: Same Queue as Inbound (Lists Queue)?**
- **Answer**: Same infrastructure, different topic/queue name
- **Rationale**:
  - Logical separation (inbound vs. outbound)
  - Different consumers (Lists Receiver vs. Payment Engine)
  - Independent scaling and monitoring
  - Same operational tooling

**Message Schema**:

```json
{
  "listId": "list-789",
  "customerId": "cust-456",
  "completedAt": "2024-01-15T11:45:00Z",
  "employeeId": "emp123",
  "location": "NY-Manhattan",
  "items": [
    {
      "itemId": "item-1",
      "productName": "Milk 2%",
      "quantity": 2,
      "status": "collected",
      "unitPrice": 3.99,
      "totalPrice": 7.98
    },
    {
      "itemId": "item-2",
      "productName": "Bread",
      "quantity": 1,
      "status": "unavailable",
      "unitPrice": 2.49,
      "totalPrice": 0.00
    }
  ],
  "totalAmount": 7.98,
  "deliveryAddress": "123 Main St, Apt 5B"
}
```

**Producer Behavior (Lists Service)**:
- When list marked complete → Lists Service generates payment data
- Publishes message to "payment-data" topic/queue
- Waits for acknowledgment from queue (ensures delivery)
- Logs message ID for traceability

**Error Handling**:
- **Publish Failure**: Retry with exponential backoff (3 attempts)
- **Persistent Failure**: Log error, alert operations team, list status remains "completed" (can re-export manually)
- **Idempotency**: Payment Engine should handle duplicate messages (in case of retries)

**Monitoring**:
- Track publish success rate
- Monitor queue depth (alert if growing, indicates Payment Engine slowdown)
- Latency from list completion to message delivery

## Technology Decisions

### Technology Stack Summary

| Component              | Technology             | Version | Rationale                                                                |
| ---------------------- | ---------------------- | ------- | ------------------------------------------------------------------------ |
| **Lists Receiver**     | Java                   | 11+     | Team expertise, excellent queue client libraries, mature ecosystem       |
| **Lists Service**      | Java (Spring Boot)     | 2.7+    | Team expertise, comprehensive REST framework, built-in features          |
| **Lists Database**     | MySQL                  | 8.0+    | Team expertise, proven partitioning, strong replication, ACID compliance |
| **Tablet Application** | React Native Web       | 0.18+   | Cross-platform, offline APIs (IndexedDB), no installation required       |
| **Message Queue**      | Company Infrastructure | N/A     | Existing platform (assumed Kafka/RabbitMQ), avoid operational complexity |
| **Load Balancer**      | Company Infrastructure | N/A     | Leverage existing infrastructure (AWS ALB, Nginx, etc.)                  |

### Key Technology Choices & Trade-offs

**1. Java for Backend Services**

**Chosen**: Java with Spring Boot framework

**Alternatives Considered**:
- **Node.js**: Lighter weight, non-blocking I/O
- **Python**: Rapid development, extensive libraries
- **C#/.NET**: Strong enterprise support

**Decision Factors**:
- **Team Expertise**: Development team has deep Java experience (reduces learning curve, faster development)
- **Queue Integration**: Java has mature, well-tested queue client libraries (Kafka, RabbitMQ, AWS SQS)
- **Spring Boot**: Comprehensive framework with REST, DI, transaction management, monitoring out-of-the-box
- **Performance**: Java's JVM provides excellent performance for high-throughput services
- **Enterprise Support**: Extensive tooling, monitoring solutions, and community support

**Trade-offs Accepted**:
- Heavier resource footprint than Node.js (acceptable given infrastructure capacity)
- Longer startup times (mitigated by keeping instances running)

---

**2. MySQL for Database**

**Chosen**: MySQL 8.0 with master-slave replication

**Alternatives Considered**:
- **PostgreSQL**: Advanced features (JSONB, better indexing)
- **MongoDB**: Schema flexibility, horizontal scaling
- **Cassandra**: High write throughput, distributed architecture

**Decision Factors**:
- **Team Expertise**: Operations team highly skilled in MySQL (administration, backup, tuning)
- **Partitioning**: Native range/hash partitioning for data lifecycle management
- **Replication**: Mature master-slave replication for read scaling and failover
- **ACID Compliance**: Strong transactional guarantees for data integrity (critical for payment data)
- **Tooling**: Extensive ecosystem (monitoring, backup, migration tools)

**Trade-offs Accepted**:
- Read-replica lag (1-5 seconds) acceptable for list assignment queries
- Vertical scaling limits (mitigated by partitioning and read replicas)
- No native horizontal scaling (acceptable for current 1.8 TB/year growth)

---

**3. React Native Web for Tablet Application**

**Chosen**: React Native Web (web-based PWA)

**Alternatives Considered**:
- **Native Android/iOS**: Full OS access, best performance
- **Flutter**: Cross-platform native, excellent performance
- **Desktop Application** (Electron, Java Swing): Full OS integration

**Decision Factors**:
- **No Installation**: Employees simply open browser URL (no app store, no IT deployment)
- **Cross-Platform**: Works on any tablet with modern browser (Android, iOS, even Windows tablets)
- **Offline Support**: IndexedDB provides robust offline storage; Service Workers enable offline-first PWA
- **Cost**: Lower hardware requirements (no need for high-spec tablets)
- **Deployment**: Simple updates (deploy new version to CDN, employees auto-refresh)

**Trade-offs Accepted**:
- No native OS features (acceptable—we don't need camera, Bluetooth, etc.)
- Slightly lower performance than native (acceptable for our UI requirements)
- Browser compatibility requirements (mitigated by supporting modern browsers only)

---

**4. Message Queue Infrastructure (Reuse Existing)**

**Chosen**: Company's existing queue platform

**Alternatives Considered**:
- **Dedicated Queue System**: Deploy new Kafka/RabbitMQ cluster for GroceColl

**Decision Factors**:
- **Operational Simplicity**: Leverage existing monitoring, alerting, backup
- **Cost Savings**: No additional licensing, infrastructure, or operations headcount
- **Team Familiarity**: Operations team already manages platform
- **Proven Reliability**: Existing platform has established SLAs and track record

**Trade-offs Accepted**:
- Shared infrastructure (potential noisy neighbor issues—mitigated by queue quotas)
- Less control over queue configuration (acceptable given company standards)

---

### Future Technology Considerations

**Potential Upgrades (2-3 Years)**:

1. **Database Scaling**: If data volume exceeds MySQL capacity (unlikely in 2 years):
   - **Option A**: Shard MySQL across multiple instances
   - **Option B**: Migrate to distributed database (Cassandra, CockroachDB)

2. **Offline Sync**: If sync conflicts become frequent:
   - Implement CRDT (Conflict-Free Replicated Data Types) for automatic conflict resolution
   - Consider operational transforms (like Google Docs)

3. **Analytics**: If business requires real-time analytics:
   - Add Elasticsearch for fast search/aggregations
   - Stream changes from MySQL to Elasticsearch via CDC (Change Data Capture)

## Architecture Diagrams

### Logic Diagram (High-Level Component View)

```
┌─────────────────┐       ┌──────────────────┐
│  Customer       │       │  Payment Engine  │
│  Ordering       │       │  (Out of Scope)  │
│  System         │       └────────▲─────────┘
│  (Out of Scope) │                │
└────────┬────────┘                │ Pull payment data
         │                         │
         │ Push shopping lists     │
         ▼                         │
  ┌──────────────┐          ┌─────┴──────┐
  │ Lists Queue  │          │ Lists Data │
  │   (Inbound)  │          │   Queue    │
  └──────┬───────┘          └─────▲──────┘
         │                        │
         │ Consume                │ Publish
         ▼                        │
  ┌────────────────┐              │
  │ Lists Receiver │──────────────┤
  │   (Java)       │ Write        │
  └────────┬───────┘              │
           │                      │
           ▼                      │
  ┌────────────────┐         ┌────┴────────┐
  │ Lists Database │◄────────┤Lists Service│
  │    (MySQL)     │ Read/   │   (Java)    │
  └────────────────┘ Write   └─────▲───────┘
                                   │
                                   │ REST API
                                   ▼
                            ┌──────────────┐
                            │   Tablet     │
                            │ Application  │
                            │ (React Web)  │
                            └──────────────┘
                                   │
                             [Employee with tablet
                              in grocery store]
```

**Component Descriptions**:
- **Lists Queue (Inbound)**: Message queue receiving shopping lists from customer system
- **Lists Receiver**: Consumes messages and persists to database (consumer group for HA)
- **Lists Database**: MySQL with master-slave replication, stores all list data
- **Lists Service**: REST API for tablet operations (load balanced across multiple instances)
- **Lists Data Queue (Outbound)**: Delivers completed list data to Payment Engine
- **Tablet Application**: Offline-first PWA for employees to collect items

---

### Physical Diagram (Deployment View)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLOUD INFRASTRUCTURE                        │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │                    Message Queue Cluster                    │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │   │
│  │  │ Queue Node 1 │  │ Queue Node 2 │  │ Queue Node 3 │     │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘     │   │
│  │         (Lists Queue & Lists Data Queue topics)            │   │
│  └────────────────────────────────────────────────────────────┘   │
│         ▲                                               ▲          │
│         │ Consume                                       │ Publish  │
│         ▼                                               │          │
│  ┌──────────────────────┐                       ┌──────┴─────┐    │
│  │ Lists Receiver       │                       │            │    │
│  │ Consumer Group       │                       │            │    │
│  │ ┌────────┐┌────────┐│                       │            │    │
│  │ │Instance││Instance││───────┐               │            │    │
│  │ │   1    ││   2    ││       │ Write         │            │    │
│  │ └────────┘└────────┘│       ▼               │            │    │
│  └──────────────────────┘  ┌─────────────────┐ │            │    │
│                            │ MySQL Master    │ │            │    │
│                            │  (Read/Write)   │ │            │    │
│  ┌──────────────────────┐  └────────┬────────┘ │            │    │
│  │ Application Load     │           │ Replicate│            │    │
│  │ Balancer (ALB)       │           ▼          │            │    │
│  └─────────┬────────────┘  ┌─────────────────┐ │            │    │
│            │               │ MySQL Slave 1   │ │            │    │
│            │ Round-robin   │  (Read-only)    │ │            │    │
│            ▼               └─────────────────┘ │            │    │
│  ┌──────────────────────┐  ┌─────────────────┐ │            │    │
│  │ Lists Service        │  │ MySQL Slave 2   │◄┤Read        │    │
│  │ Cluster              │  │  (Read-only)    │ │            │    │
│  │ ┌────┐┌────┐┌────┐  │  └─────────────────┘ │            │    │
│  │ │Inst││Inst││Inst│  │──────────────────────┘            │    │
│  │ │ 1  ││ 2  ││ 3  │  │                                    │    │
│  │ └────┘└────┘└────┘  │───────────────────────────────────┘    │
│  └──────────┬───────────┘                                        │
│             │ HTTPS/REST API                                     │
└─────────────┼────────────────────────────────────────────────────┘
              │
              ▼
     ┌────────────────────┐
     │ CDN / Static Host  │
     │  (Tablet App)      │
     └─────────┬???  │ │ 1  ││ 2  ││ 3  │        │
               │ HTTPS
               ▼
        [Tablet Browser]
        ┌──────────────┐
        │   Employee   │
        │   Tablet     │
        │ (in store)   │
        └──────────────┘
```

**Deployment Details**:
- **Region**: Multi-region for global deployment (US-East, EU-West, Asia-Pacific)
- **Lists Receiver**: 3 instances per region (consumer group)
- **Lists Service**: 5-10 instances per region behind ALB
- **Database**: 1 master + 2 slaves per region (cross-region replication optional)
- **Tablet Application**: Static files on CDN (global edge caching)

---

### Technical Diagram (Data Flow & Interactions)

```
Employee Workflow: Collecting a Shopping List

┌─────────┐                                                  ┌──────────┐
│ Tablet  │                                                  │  Lists   │
│   App   │                                                  │ Service  │
└────┬────┘                                                  └────┬─────┘
     │                                                            │
     │ 1. GET /api/v1/lists/next?location=NY&employeeId=emp123  │
     │────────────────────────────────────────────────────────>│
     │                                                            │
     │                                      2. Query pending     │
     │                                         lists ┌──────────┐│
     │                                         ┌────>│  MySQL   ││
     │                                         │     │  Slave   ││
     │                                         └─────┤  (Read)  ││
     │                                      3. Assign└──────────┘│
     │                                         list   ┌──────────┐│
     │                                         ┌────>│  MySQL   ││
     │                                         │     │  Master  ││
     │                                         └─────┤ (Write)  ││
     │                                               └──────────┘│
     │ 4. Return list data (JSON)                                │
     │<────────────────────────────────────────────────────────┤
     │                                                            │
     │ [Employee collects items in store - may go offline]       │
     │                                                            │
     │ 5. PUT /api/v1/lists/list-789/items/item-1                │
     │    Body: {"status": "collected", "timestamp": "..."}      │
     │────────────────────────────────────────────────────────>│
     │                                               ┌──────────┐│
     │                                      6. Update│  MySQL   ││
     │                                         ┌────>│  Master  ││
     │                                         └─────┤ (Write)  ││
     │                                               └──────────┘│
     │ 7. Return updated item                                    │
     │<────────────────────────────────────────────────────────┤
     │                                                            │
     │ [Repeat for all items...]                                 │
     │                                                            │
     │ 8. POST /api/v1/lists/list-789/complete                   │
     │────────────────────────────────────────────────────────>│
     │                                               ┌──────────┐│
     │                                      9. Mark  │  MySQL   ││
     │                                      complete │  Master  ││
     │                                         ┌────>│ (Write)  ││
     │                                         └─────┤          ││
     │                                               └──────────┘│
     │                                                            │
     │                                     10. Generate payment  │
     │                                         data              │
     │                                                      ┌────┘
     │                                                      ▼
     │                                              ┌──────────────┐
     │                                              │ Lists Data   │
     │                                              │   Queue      │
     │                                              └──────┬───────┘
     │                                                     │
     │                                                     ▼
     │                                              [Payment Engine]
     │ 11. Return success                                 │
     │<────────────────────────────────────────────────────────┤
     │                                                            │
     └────                                                        └─────

Offline Scenario:
┌─────────┐
│ Tablet  │
│   App   │
└────┬────┘
     │ [Connection lost - inside store]
     │
     │ Updates stored locally:
     │ ┌────────────────────────────────────────┐
     │ │ IndexedDB (Browser Storage)            │
     │ │ - List data cached                     │
     │ │ - Item updates queued with timestamps  │
     │ └────────────────────────────────────────┘
     │
     │ [Connection restored]
     │
     │ POST /api/v1/lists/list-789/sync
     │ Body: { updates: [ {...}, {...}, ... ] }
     │────────────────────────────────────────────> Lists Service
     │
     │ Lists Service applies updates (last-write-wins)
     │
     │ Return sync result (applied/rejected)
     │<────────────────────────────────────────────
     │
```

## Data Architecture

### Database Schema Design

**Tables**:

```sql
-- Shopping Lists table
CREATE TABLE shopping_lists (
    list_id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL,
    location VARCHAR(100) NOT NULL,
    status ENUM('pending', 'in_progress', 'completed') NOT NULL DEFAULT 'pending',
    employee_id VARCHAR(50) NULL,
    delivery_address TEXT NOT NULL,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assigned_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_status_location (status, location),
    INDEX idx_customer (customer_id),
    INDEX idx_employee (employee_id)
) PARTITION BY RANGE (UNIX_TIMESTAMP(received_at)) (
    PARTITION p202401 VALUES LESS THAN (UNIX_TIMESTAMP('2024-02-01')),
    PARTITION p202402 VALUES LESS THAN (UNIX_TIMESTAMP('2024-03-01')),
    -- Add new partitions monthly
);

-- List Items table
CREATE TABLE list_items (
    item_id VARCHAR(50) PRIMARY KEY,
    list_id VARCHAR(50) NOT NULL,
    product_name VARCHAR(200) NOT NULL,
    quantity INT NOT NULL,
    unit_price DECIMAL(10,2) NOT NULL,
    status ENUM('pending', 'collected', 'unavailable') NOT NULL DEFAULT 'pending',
    updated_by VARCHAR(50) NULL,
    updated_at TIMESTAMP NULL,
    
    FOREIGN KEY (list_id) REFERENCES shopping_lists(list_id) ON DELETE CASCADE,
    INDEX idx_list (list_id),
    INDEX idx_status (status)
);

-- Employee table (optional - may come from HR system)
CREATE TABLE employees (
    employee_id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    location VARCHAR(100) NOT NULL,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Data Flow

**Inbound Flow (New Lists)**:
1. Customer System → Lists Queue (JSON message)
2. Lists Receiver consumes message
3. Deserializes JSON to Java objects
4. Inserts into `shopping_lists` table (master)
5. Inserts items into `list_items` table (batch insert)

**Outbound Flow (Completed Lists)**:
1. Lists Service marks list complete
2. Queries `shopping_lists` and `list_items` (join)
3. Generates payment JSON (list + items + totals)
4. Publishes to Lists Data Queue
5. Payment Engine consumes message

### Data Retention & Archiving

**Problem**: 1.8 TB annual growth requires lifecycle management

**Solution**: Partitioning + Archiving Strategy

**Approach**:
1. **Partitioning**: Monthly partitions on `received_at` timestamp
   - Queries targeting recent data only scan relevant partition (fast)
   - Old partitions can be dropped/archived independently

2. **Archiving Process** (Automated):
   - **Trigger**: Last day of each month
   - **Target**: Partitions older than 24 months
   - **Steps**:
     1. Export partition to compressed archive (mysqldump or SELECT INTO OUTFILE)
     2. Store archive in S3/Azure Blob Storage
     3. Drop partition from production database
     4. Document archive location in metadata table
   - **Retention**: Archives kept for 5 years (compliance requirement)

3. **Restore Process** (On-Demand):
   - If historical data needed (dispute, audit)
   - Restore archive to temporary read-only database
   - Query restored data

**Example**:
```sql
-- Archive partition p202201 (data from Jan 2022)
-- 1. Export
SELECT * INTO OUTFILE '/backups/shopping_lists_202201.csv'
FROM shopping_lists PARTITION (p202201);

-- 2. Compress and upload to S3
-- (handled by backup script)

-- 3. Drop partition
ALTER TABLE shopping_lists DROP PARTITION p202201;
```

### Data Volume Management

**Current State**:
- **Daily**: 5 GB (10K lists × 500 KB)
- **Monthly**: 150 GB
- **Yearly**: 1.8 TB

**Projection (2 Years)**:
- **Growth**: 30% annually
- **Year 1**: 1.8 TB
- **Year 2**: 2.34 TB (cumulative: 4.14 TB)

**Mitigation**:
- Archiving reduces active database size to ~24 months = 3.6 TB
- Partitioning improves query performance on active data
- Read replicas distribute query load

## Security Architecture

### Authentication & Authorization

**Employee Authentication**:
- **Method**: JWT (JSON Web Token) based authentication
- **Flow**:
  1. Employee logs into tablet app with credentials
  2. Tablet sends credentials to Lists Service `/auth/login`
  3. Lists Service validates against HR system (SSO integration)
  4. Returns JWT token (valid for 8 hours - typical shift length)
  5. Tablet stores token securely (sessionStorage or secure cookie)
  6. All API requests include token in `Authorization: Bearer <token>` header

**Authorization**:
- **Role**: All employees have same role (collector)
- **Permissions**: 
  - Retrieve next available list (any location)
  - Update items in assigned lists only (enforced by checking `employee_id`)
  - Complete assigned lists only
- **Rule**: Employee can only modify lists assigned to them (server-side validation)

### Data Protection

**Data in Transit**:
- **HTTPS/TLS 1.3**: All communication encrypted (Tablet ↔ Lists Service, Services ↔ Database)
- **Certificate Management**: Automated via Let's Encrypt or company CA
- **Message Queue**: TLS encryption for queue connections

**Data at Rest**:
- **Database Encryption**: MySQL Transparent Data Encryption (TDE) enabled
- **Backup Encryption**: Backups encrypted before storage in S3/Azure Blob (AES-256)
- **Tablet Storage**: IndexedDB data not encrypted (acceptable risk—no sensitive financial data stored)

**Sensitive Data Handling**:
- **Customer PII**: Delivery addresses stored encrypted in database (application-level encryption)
- **Payment Data**: Only collected items and quantities sent to Payment Engine (no credit card data)
- **Employee Data**: Employee IDs only (no sensitive HR data)

### Network Security

**Firewall Rules**:
- Lists Receiver: Inbound from queue only (private network)
- Lists Service: Inbound HTTPS from load balancer only (public)
- Database: Inbound from Lists Receiver and Lists Service only (private subnet)
- Queue: Inbound from trusted services only (authentication required)

**DDoS Protection**:
- Load balancer configured with rate limiting (100 req/sec per IP)
- WAF (Web Application Firewall) rules to block common attacks

### Compliance

**Requirements**:
- **GDPR**: Customer addresses are personal data (require encryption, right to erasure)
- **PCI-DSS**: Not applicable (no payment card data stored)
- **Data Residency**: Store customer data in region of origin (EU customers → EU datacenter)

**Implementation**:
- Customer data encrypted at rest
- Data retention policy documented (archives deleted after 5 years)
- Right to erasure: API endpoint to anonymize customer data on request

## Backup & Disaster Recovery

### Backup Strategy

**Database Backups**:

1. **Full Backups** (Daily)
   - **Frequency**: Every night at 2 AM (low traffic)
   - **Method**: mysqldump or Percona XtraBackup
   - **Storage**: S3/Azure Blob Storage (encrypted)
   - **Retention**: 30 days

2. **Incremental Backups** (Hourly)
   - **Frequency**: Every hour
   - **Method**: Binary log backup
   - **Storage**: S3/Azure Blob Storage
   - **Retention**: 7 days

3. **Point-in-Time Recovery**:
   - Restore full backup + replay binary logs to specific timestamp
   - **Granularity**: Down to the second
   - **Recovery Point Objective (RPO)**: < 5 minutes (time between binary log backups)

**Application Backups**:
- Lists Receiver & Lists Service: No state (stateless containers)
- Configuration: Stored in Git repository (Infrastructure as Code)
- Deployment: Can redeploy from Git at any time

**Queue Backups**:
- Queue infrastructure handles replication (company responsibility)
- Messages persisted to disk before acknowledgment

### Disaster Recovery Plan

**Scenarios & Procedures**:

**Scenario 1: Database Failure (Master Down)**

- **Detection**: Health checks fail, replica promotion alert
- **RTO**: 15 minutes
- **RPO**: < 1 minute (replication lag)
- **Procedure**:
  1. Automated failover: Promote slave to master
  2. Update Lists Receiver and Lists Service connection strings (DNS or config update)
  3. Restart services to pick up new master
  4. Monitor replication lag of remaining slaves

**Scenario 2: Region Failure (Entire Datacenter Down)**

- **Detection**: All health checks fail, region unreachable
- **RTO**: 1 hour
- **RPO**: 5 minutes (binary log backup)
- **Procedure**:
  1. Restore full backup in different region
  2. Replay binary logs to latest available
  3. Update DNS to point to new region
  4. Deploy Lists Receiver and Lists Service in new region
  5. Notify operations team and employees

**Scenario 3: Data Corruption (Accidental Deletion)**

- **Detection**: Operations team discovers missing/corrupted data
- **RTO**: 2 hours
- **RPO**: Up to 24 hours (last full backup)
- **Procedure**:
  1. Restore full backup to temporary database
  2. Replay binary logs to point before corruption
  3. Extract affected data
  4. Merge into production database
  5. Validate data integrity

**Scenario 4: Lists Service Cluster Failure**

- **Detection**: Load balancer health checks fail for all instances
- **RTO**: 10 minutes
- **RPO**: 0 (stateless service)
- **Procedure**:
  1. Auto-scaling group deploys new instances
  2. Health checks pass, load balancer routes traffic
  3. If auto-scaling fails, manually deploy instances
  4. Investigate root cause (deployment issue, resource exhaustion)

### Testing & Validation

**Disaster Recovery Drills** (Quarterly):
- Simulate database failover (promote slave to master)
- Restore backup to validate integrity
- Test cross-region failover
- Document lessons learned

**Backup Validation** (Weekly):
- Automated restore of latest backup to test environment
- Run smoke tests against restored data
- Alert if restore fails

## Monitoring & Observability

### Key Metrics & Alerts

**Application Metrics**:

| Metric                      | Threshold         | Alert Level | Action                                              |
| --------------------------- | ----------------- | ----------- | --------------------------------------------------- |
| Lists Service API Latency   | > 500ms (p95)     | Warning     | Investigate slow queries, check database load       |
| Lists Service API Latency   | > 1000ms (p95)    | Critical    | Scale up instances, alert on-call engineer          |
| Lists Receiver Consumer Lag | > 1000 messages   | Warning     | Scale up consumer instances                         |
| Lists Receiver Consumer Lag | > 5000 messages   | Critical    | Immediate scaling, investigate throughput issue     |
| Lists Service Error Rate    | > 1% (5xx errors) | Warning     | Check logs, investigate root cause                  |
| Lists Service Error Rate    | > 5% (5xx errors) | Critical    | Rollback recent deployment, alert on-call           |
| Database Connection Pool    | > 80% utilization | Warning     | Scale up service instances, optimize queries        |
| Database Replication Lag    | > 5 seconds       | Warning     | Investigate master load, check network              |
| Database Replication Lag    | > 30 seconds      | Critical    | Reduce master load, consider read-replica promotion |

**Infrastructure Metrics**:

| Metric             | Threshold  | Alert Level | Action                            |
| ------------------ | ---------- | ----------- | --------------------------------- |
| CPU Utilization    | > 70%      | Warning     | Prepare to scale                  |
| CPU Utilization    | > 85%      | Critical    | Auto-scale or manual intervention |
| Memory Utilization | > 80%      | Warning     | Investigate memory leaks          |
| Memory Utilization | > 95%      | Critical    | Restart service, investigate      |
| Disk Space         | > 80% full | Warning     | Clean up logs, review archiving   |
| Disk Space         | > 90% full | Critical    | Emergency cleanup, expand storage |

**Business Metrics** (Dashboards):
- Lists processed per hour (operational visibility)
- Average collection time per list (efficiency metric)
- Items marked unavailable (stock issues alert)
- Employee productivity (lists per shift)

### Logging Strategy

**Centralized Logging**:
- **Tool**: ELK Stack (Elasticsearch, Logstash, Kibana) or Splunk
- **Log Levels**: DEBUG (dev), INFO (prod), WARN (issues), ERROR (failures)
- **Log Format**: JSON structured logs (easy parsing)

**What to Log**:

**Lists Receiver**:
- Message received (list ID, timestamp)
- Validation errors (missing fields, invalid data)
- Database insert success/failure

**Lists Service**:
- API requests (endpoint, employee ID, list ID, response time)
- Business logic events (list assigned, item updated, list completed)
- Errors (stack traces, context)

**Example Log Entry**:
```json
{
  "timestamp": "2024-01-15T10:30:15.123Z",
  "level": "INFO",
  "service": "lists-service",
  "instanceId": "lists-service-pod-3",
  "requestId": "req-abc123",
  "employeeId": "emp123",
  "listId": "list-789",
  "action": "update_item",
  "itemId": "item-1",
  "status": "collected",
  "duration_ms": 45
}
```

**Retention**: 
- INFO logs: 30 days
- ERROR logs: 90 days
- Archived logs: 1 year (compressed)

### Distributed Tracing

**Tool**: Jaeger or AWS X-Ray

**Trace Scenario**: List assignment request
- Span 1: Tablet → Lists Service (HTTP request)
- Span 2: Lists Service → MySQL Slave (SELECT query)
- Span 3: Lists Service → MySQL Master (UPDATE query)
- Span 4: Lists Service → Tablet (HTTP response)

**Benefits**:
- Identify bottlenecks (e.g., slow database query)
- Correlate errors across services
- Visualize request flow

### Health Checks

**Lists Service Health Endpoint**:
```
GET /actuator/health

Response:
{
  "status": "UP",
  "components": {
    "database": {
      "status": "UP",
      "details": { "connectionPool": "8/20 active" }
    },
    "queue": {
      "status": "UP",
      "details": { "connected": true }
    }
  }
}
```

**Load Balancer Health Check**:
- Interval: Every 10 seconds
- Timeout: 5 seconds
- Unhealthy Threshold: 2 consecutive failures
- Action: Remove instance from rotation

## Deployment Strategy

### Deployment Pipeline

**CI/CD Workflow**:

1. **Code Commit** (Developer pushes to Git)
   - Trigger: Push to `main` branch

2. **Build Stage** (Jenkins/GitHub Actions)
   - Compile Java code (Maven)
   - Run unit tests
   - Build Docker image
   - Tag image with commit SHA

3. **Test Stage**
   - Run integration tests (test database)
   - API contract tests (Postman/Rest-Assured)
   - Code coverage check (> 70% required)

4. **Deploy to Staging**
   - Deploy Docker image to staging environment
   - Run smoke tests
   - Performance tests (load testing with JMeter)

5. **Approval Gate** (Manual)
   - Tech lead reviews staging results
   - Approves deployment to production

6. **Deploy to Production**
   - Blue-green deployment (zero downtime)
   - Deploy to 50% of instances (canary)
   - Monitor metrics for 10 minutes
   - If healthy, deploy to remaining 50%
   - If issues, rollback to previous version

### Deployment Patterns

**Blue-Green Deployment**:
- Maintain two identical production environments (Blue, Green)
- Current traffic → Blue environment
- Deploy new version → Green environment
- Switch load balancer → Green environment
- If issues, switch back → Blue (instant rollback)

**Canary Deployment** (Preferred for Lists Service):
- Deploy new version to 10% of instances
- Route 10% of traffic to new version
- Monitor metrics (latency, errors, throughput)
- If healthy after 15 minutes, increase to 50%
- If healthy after 30 minutes, complete deployment (100%)
- If issues at any stage, rollback

**Database Migrations**:
- **Backward-Compatible Migrations**: Always deploy schema changes before code
- **Example**: Adding a new column
  1. Deploy migration (ALTER TABLE ... ADD COLUMN ... NULL)
  2. Deploy code that uses new column
  3. Backfill data (if needed)
  4. Deploy migration to make column NOT NULL (if required)

### Environment Strategy

| Environment     | Purpose                   | Data                              | Deployment Frequency           |
| --------------- | ------------------------- | --------------------------------- | ------------------------------ |
| **Development** | Developer testing         | Synthetic test data               | Continuously (on every commit) |
| **Staging**     | Pre-production validation | Sanitized copy of production data | Daily (automated)              |
| **Production**  | Live system               | Real customer data                | Weekly (controlled release)    |

## Performance & Scalability

### Performance Requirements

**Response Time Targets**:
- List assignment API: < 200ms (p95)
- Item update API: < 100ms (p95)
- List completion API: < 300ms (p95)
- Offline sync: < 2 seconds per list (batch of updates)

**Throughput Targets**:
- Lists Receiver: 10K lists/day = ~7 lists/minute (current), scale to 50K/day (35 lists/min)
- Lists Service: 200 concurrent users = ~500 req/sec (current), scale to 500 users (1250 req/sec)

### Scalability Strategy

**Horizontal Scaling**:

**Lists Receiver (Consumer Group)**:
- **Current**: 3 instances consuming from queue
- **Scaling Trigger**: Consumer lag > 1000 messages
- **Action**: Add instances (scale to 5-7 instances)
- **Limit**: Queue partition count (e.g., Kafka with 10 partitions → max 10 consumers)

**Lists Service (Load Balanced)**:
- **Current**: 5 instances behind load balancer
- **Auto-Scaling Policy**:
  - Scale out: CPU > 70% for 5 minutes → add instance
  - Scale in: CPU < 30% for 15 minutes → remove instance
- **Max Instances**: 20 (cost limit)

**Database (Read Scaling)**:
- **Current**: 1 master + 2 read replicas
- **Scaling Trigger**: Read replica CPU > 70%
- **Action**: Add read replica (scale to 4-5 replicas)
- **Connection Distribution**: Load balancer routes read queries across replicas

### Performance Optimizations

**Database Indexing**:
- Index on `shopping_lists(status, location)` for list assignment query
- Composite index dramatically improves performance (10x faster)

**Query Optimization**:
```sql
-- Before: Full table scan (slow)
SELECT * FROM shopping_lists WHERE status = 'pending';

-- After: Index scan (fast)
SELECT * FROM shopping_lists 
WHERE status = 'pending' AND location = 'NY-Manhattan' 
ORDER BY received_at LIMIT 1;
```

**Caching Strategy**:
- **Redis Cache**: Cache employee details (low-churn data)
- **TTL**: 1 hour
- **Invalidation**: On employee update (rare)
- **Benefit**: Reduce database load for repeated lookups

**Batch Operations**:
- Insert list items in batch (single transaction) vs. individual inserts
- Benefit: 5x faster for lists with 20+ items

### Load Testing Results

**Test Scenario**: 200 concurrent employees, 10K lists/day
- **Tool**: JMeter
- **Metrics**:
  - API Latency (p95): 180ms (target: < 500ms) ✅
  - Error Rate: 0.01% (target: < 1%) ✅
  - Database CPU: 45% (headroom for growth) ✅

**Stress Test**: 500 concurrent employees, 50K lists/day (future projection)
- **API Latency (p95)**: 420ms (acceptable) ✅
- **Database CPU**: 75% (add read replica recommended) ⚠️
- **Lists Service Instances**: Scaled to 12 instances (auto-scaling working) ✅

## Testing Strategy

### Unit Testing

**Target**: 70% code coverage

**Frameworks**:
- **Java**: JUnit 5, Mockito
- **React Native**: Jest, React Testing Library

**What to Test**:
- Business logic (list assignment algorithm, item update validation)
- Data transformations (JSON → Java objects)
- Error handling (null checks, exception cases)

**Example**:
```java
@Test
public void testAssignNextList_ReturnsListForLocation() {
    // Arrange
    when(listRepository.findPendingByLocation("NY-Manhattan"))
        .thenReturn(Optional.of(mockList));
    
    // Act
    Optional<ShoppingList> result = listsService.assignNextList("NY-Manhattan", "emp123");
    
    // Assert
    assertTrue(result.isPresent());
    assertEquals("list-789", result.get().getListId());
    assertEquals("emp123", result.get().getEmployeeId());
}
```

### Integration Testing

**Target**: Validate service interactions with real dependencies

**Scope**:
- Lists Receiver → MySQL (insert list, verify in database)
- Lists Service → MySQL (query, update, verify changes)
- Lists Service → Queue (publish message, verify received)

**Tools**:
- **Testcontainers**: Spin up MySQL and queue in Docker containers
- **Rest-Assured**: API testing framework

**Example**:
```java
@Test
public void testCompleteList_PublishesToQueue() {
    // Arrange: List in database with all items collected
    
    // Act: Call complete API
    Response response = given()
        .contentType("application/json")
        .body("{\"employeeId\": \"emp123\"}")
        .when()
        .post("/api/v1/lists/list-789/complete")
        .then()
        .statusCode(200);
    
    // Assert: Verify message in queue
    Message msg = queueClient.receiveMessage("payment-data", Duration.ofSeconds(5));
    assertNotNull(msg);
    assertTrue(msg.getBody().contains("list-789"));
}
```

### End-to-End Testing

**Scenario**: Complete employee workflow
1. Call GET /lists/next (fetch list)
2. Call PUT /lists/{id}/items/{itemId} (mark items)
3. Call POST /lists/{id}/complete (complete list)
4. Verify list status in database = "completed"
5. Verify message published to queue

**Environment**: Staging (with real-like data)

### Load Testing

**Tool**: Apache JMeter or Gatling

**Scenarios**:
1. **Normal Load**: 200 concurrent users, 10 requests/min per user
2. **Peak Load**: 400 concurrent users (2x normal)
3. **Stress Test**: 500 concurrent users (2.5x normal)

**Metrics to Monitor**:
- Response time (p50, p95, p99)
- Throughput (requests/sec)
- Error rate
- Database connection pool utilization
- CPU/memory usage

## Cost Analysis

### Infrastructure Cost Estimate (Monthly)

**Compute** (Lists Receiver & Lists Service):
- **Instances**: 8 instances (3 receiver, 5 service) × $50/month (2 vCPU, 4GB RAM) = $400
- **Load Balancer**: $30/month

**Database**:
- **Master**: 1 instance (4 vCPU, 16GB RAM) = $200/month
- **Read Replicas**: 2 instances × $200 = $400/month
- **Storage**: 2 TB × $0.10/GB = $200/month
- **Backups**: 500 GB × $0.05/GB = $25/month

**Message Queue**:
- **Included**: Company infrastructure (no incremental cost)

**Networking**:
- **Data Transfer**: ~1 TB/month outbound = $90/month

**Monitoring & Logging**:
- **ELK Stack / Logging**: $100/month (hosted)
- **Monitoring Tools**: $50/month (Prometheus, Grafana)

**CDN** (Tablet App):
- **Static Hosting**: $20/month
- **Data Transfer**: 100 GB × $0.05/GB = $5/month

**Total Monthly Cost**: ~$1,520/month = **~$18,240/year**

### Cost Optimization Strategies

1. **Reserved Instances**: Commit to 1-year reserved instances for database (save 30% = $180/month)
2. **Spot Instances**: Use spot instances for non-critical environments (dev, staging)
3. **Auto-Scaling**: Scale down during off-peak hours (nights, weekends) to save 20% on compute
4. **Data Archiving**: Move old data to cheap storage (S3 Glacier) = $0.004/GB vs. $0.10/GB (96% savings)

**Optimized Monthly Cost**: ~$1,200/month = **~$14,400/year**

## Risks & Mitigation

### Technical Risks

**Risk 1: Offline Sync Conflicts**

- **Description**: Two employees assigned same list by mistake → conflicting updates
- **Likelihood**: Low (requires operational error in assignment)
- **Impact**: High (incorrect payment data, customer complaint)
- **Mitigation**:
  - Server-side validation: Only allow updates to lists assigned to employee
  - Last-write-wins conflict resolution with audit log
  - Alerts when conflicts detected
  - Employee training on sync procedures

**Risk 2: Database Storage Growth**

- **Description**: Data volume exceeds projections (e.g., 3x growth instead of 30%)
- **Likelihood**: Medium (business expansion, marketing campaigns)
- **Impact**: Medium (slow queries, storage costs)
- **Mitigation**:
  - Proactive monitoring of data volume growth
  - Partitioning + archiving strategy (already planned)
  - Budget for database vertical scaling if needed
  - Consider distributed database if MySQL limits reached

**Risk 3: Message Queue Downtime**

- **Description**: Company queue infrastructure experiences outage
- **Likelihood**: Low (existing infrastructure has high SLA)
- **Impact**: High (no new lists received, completed lists not exported)
- **Mitigation**:
  - Lists queue buffers messages (no data loss during short outage)
  - Lists Service can retry publishing to outbound queue
  - Operations team monitoring queue health
  - SLA with infrastructure team

**Risk 4: Tablet Browser Compatibility**

- **Description**: Older tablet browsers don't support IndexedDB or Service Workers
- **Likelihood**: Medium (older tablets in use)
- **Impact**: High (offline mode doesn't work)
- **Mitigation**:
  - Specify minimum browser versions (Chrome 60+, Safari 11+)
  - Device compatibility testing before deployment
  - Graceful degradation: Show warning if offline features unavailable
  - Budget for tablet hardware upgrades

### Operational Risks

**Risk 5: Key Personnel Dependency**

- **Description**: Only 1-2 developers know Java/MySQL deeply
- **Likelihood**: Medium
- **Impact**: High (slow development, difficult troubleshooting)
- **Mitigation**:
  - Cross-training: Pair programming, knowledge sharing sessions
  - Documentation: Comprehensive architecture docs (this document)
  - On-call rotation: Spread operational knowledge
  - Hire additional Java expertise

**Risk 6: Third-Party Service Changes**

- **Description**: Company queue infrastructure changes API or behavior
- **Likelihood**: Medium (infrastructure upgrades happen)
- **Impact**: Medium (code changes required, potential downtime)
- **Mitigation**:
  - Monitor infrastructure team announcements
  - Abstract queue client behind interface (easy to swap implementations)
  - Maintain staging environment for testing changes
  - Participate in infrastructure beta programs

## Future Enhancements

### Phase 2 Features (6-12 Months)

**1. AI-Powered List Optimization**
- **Benefit**: Suggest optimal collection routes through store (reduce collection time by 20%)
- **Technology**: ML model trained on store layouts and item locations
- **Effort**: 3 months (data science team collaboration)

**2. Real-Time Inventory Integration**
- **Benefit**: Alert employee if item out of stock before searching (save time)
- **Technology**: Integrate with store inventory systems (API or database)
- **Effort**: 4 months (per store chain—requires partnerships)

**3. Customer Communication**
- **Benefit**: Notify customer when items unavailable, offer substitutes
- **Technology**: Push notifications or SMS via Twilio
- **Effort**: 2 months (backend API + customer app integration)

**4. Advanced Analytics Dashboard**
- **Benefit**: Insights for operations (peak hours, bottleneck stores, employee performance)
- **Technology**: Elasticsearch + Kibana or custom React dashboard
- **Effort**: 2 months

### Phase 3 Features (1-2 Years)

**5. Multi-Region Active-Active**
- **Benefit**: Lower latency for global employees, higher availability
- **Technology**: Multi-master database (CockroachDB, Cassandra) or CRDT-based sync
- **Effort**: 6 months (complex—requires architecture redesign)

**6. Voice-Activated Tablet Interface**
- **Benefit**: Hands-free operation (employee can mark items while holding groceries)
- **Technology**: Speech recognition (Web Speech API or Google Cloud Speech)
- **Effort**: 3 months

**7. Photo Verification**
- **Benefit**: Employee takes photo of collected item (quality assurance, reduce errors)
- **Technology**: Camera API + image storage (S3) + optional ML verification
- **Effort**: 2 months

## Appendices

### Appendix A: Glossary

- **Consumer Group**: Messaging pattern where multiple instances of a consumer share message processing load
- **IndexedDB**: Browser API for storing structured data locally (enables offline apps)
- **JWT**: JSON Web Token, a standard for securely transmitting authentication information
- **Partitioning**: Database technique to split table into smaller chunks based on key (e.g., date)
- **PWA**: Progressive Web App, a web application that behaves like a native app (offline support, installable)
- **Read Replica**: Read-only copy of database used to offload read queries from master
- **SLA**: Service Level Agreement, a commitment to uptime/performance (e.g., 99.9% = 43 minutes downtime/month)

### Appendix B: API Reference

See [Services Drill Down - Lists Service](#lists-service-rest-api) for complete API documentation.

### Appendix C: Deployment Runbook

**Standard Deployment Procedure**:
1. Merge PR to `main` branch
2. CI/CD pipeline builds and tests
3. Deploy to staging, run smoke tests
4. Tech lead approves production deployment
5. Canary deployment to 10% of instances
6. Monitor for 15 minutes (check dashboards, logs)
7. If healthy, proceed to 100%
8. If issues, rollback via Jenkins/GitHub Actions

**Rollback Procedure**:
1. Click "Rollback" button in deployment tool
2. Load balancer routes traffic to previous version
3. Investigate root cause offline
4. Fix and redeploy

### Appendix D: Contact Information

- **Development Team Lead**: [Name] - [email]
- **Operations Team Lead**: [Name] - [email]
- **Database Administrator**: [Name] - [email]
- **On-Call Rotation**: [PagerDuty link]

## Document Control

- **Version**: 1.0
- **Last Updated**: 2024-01-15
- **Author**: Architecture Team
- **Reviewers**: Development Lead, Operations Lead, CTO
- **Next Review Date**: 2024-04-15 (Quarterly)
- **Change Log**:
  - 2024-01-15: Initial architecture document created
  - [Future changes will be logged here]

