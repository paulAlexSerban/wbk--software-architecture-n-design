# GroceColl - Grocery Collection Service
> FROM: "Software Architecture Case Studies" on Udemy

## Overview
GroceColl is a grocery collection service that enables customers to create shopping lists which are then collected and delivered by GroceColl's employees. Customers can use GroceColl to create shopping lists, and GroceColl's employees will collect the items from a grocery store and deliver them to the customer's home. The service is available worldwide, and employees are equipped with dedicated tablets that display the shopping lists.

### Bulleted Summary
- grocery collection service
- allows customers to create shopping lists that get collected and delivered by GroceColl's employees
- using GroceColl's, we as customers can create shopping lists and then have GroceColl's employees collect the items from a grocery store and deliver them to our home
- available worldwide
- employees have dedicated tablets displaying the list
- we need to design the collection side fo the system
  - the customer side is already developed and out of scope for this case study


## Requirements
### Functional Requirements (What the system should do)
- web based 
- tablets receive list to be collected
- employees can mark items as collected or unavailable
- when collection is done, the list should be transfered to payment engine (payment engine is out of scope)
- offline support is a must-have (employees may not have internet connection in the store)

### Non-Functional Requirements (What the system should deal with)
What we ask?
- How many expected concurrent users? ~200 (at peak hours)
- How many lists will be processed per day? (will help calculate the expected data volume of the system) ~10000 lists/day
- What is the average size of a shopping list? (will help calculate the expected data volume of the system) ~500 KB per list
- Do we need offline support? (yes, must-have) - employees may not have internet connection in the store
- What is the desired SLA? (99.9% uptime) - Highest possible availability
- How do lists arive to the system? (from mobile app, web app, etc) - queue

Data Volume
- 1 list =~ 500 KB
- 10,000 lists/day =~ 5 GB/day
- 300000 lists/month =~ 150 GB/month
- 3600000 lists/year =~ 2 TB/year

Non-Functional Requirements Summary
- 200 concurrent users
- 10,000 lists/day
- Yearly data volume =~ 2 TB
- High SLA
- Offline support

## Executive Summary

## Components
Based on [the requirements](#requirements), the following components can be identified for the GroceColl system:
- Lists Queue (out of scope of the system) - the shopiing list is retrived from the Lists Queue
- Lists Receiver - receives the list from the queue and stores it in the Lists Database
- Lists Service - retrives the lists to be handled, updates the lists, and exports items and lists
- Lists Database - stores the lists and their statuses
  - Lists Receiver and Lists Service are two different components for the reasons of separation of concerns and scalability, if changes are needed in the future each component can be modified independently
- Tablet Application - displays list, marks items, must support offline mode
- Lists Data - data to be exported to the Payment Engine (out of scope of the system)

### Messaging System
- REST API exposed by the Lists Service
- Queue for Lists Data from the payemnt engine will pull the data previously pushed by the Lists Service

### Scaling

## Services Drill Down
### Lists Receiver
What it does:
- receives shopping lists to be handled from queue
- stores the lists in the Lists Database

Application Type: Service (continously running application, no HTTP interface)
Technology Stack:
- Considerations: should be able to connect the queue
- Client Development Team preferred technology: Java and MySQL
- Chosen Technology: Java is perfect for this type of application, MySQL is a good fit for the database as well
- Expected volume is 2TB/year, which requires DB partitioning and archiving strategies
- Final Technology Stack: Java, MySQL

Architecture:
- Start from classic 3-tier architecture
- Layers:
  - Queue Receiver Layer: connects to the queue and retrieves the lists
  - Business Logic Layer: processes the lists and prepares them for storage
  - Data Access Layer: interacts with the Lists Database to store the lists
  - Database Layer: MySQL database to store the lists

Redundancy and High Availability:
- Consumer group with multiple instances of the Lists Receiver to ensure high availability and load balancing
  - Consumner Group - concept found in messaging systems like Kafka, where multiple instances of a consumer application work together to consume messages from a topic
  - basically it is a load balancer implemented by the queue mechanism itself

### Lists Service
What does it do:
- allows employees to query lists to be collected
- marks items in list as collected or unavailable
- marks list as collected when done
- exports payment data to Payment Engine

Application Type: Web API
Technology Stack:
- Considerations: should be able to connect to the database, should be able to expose REST API
- Client Development Team preferred technology: Java and MySQL
- Chosen Technology: Java is perfect for this type of application, MySQL is a good fit for the database as well

Architecture:
- Start from classic 3-tier architecture
- Layers:
  - Service Layer: exposes REST API for Tablet Application
  - Business Logic Layer: processes the requests from the Tablet Application
  - Data Access Layer: interacts with the Lists Database to retrieve and update lists
  - Database Layer: MySQL database to store the lists

API:
- get next list to be processed (by location, employee id, etc)
- mark item as collected or unavailable
- export lists payment data to Payment Engine

API Design:

| Functionality                               | Method | Path/Endpoint                                                  | Return Codes                                                       |
| ------------------------------------------- | ------ | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Get next list to be processed               | GET    | /api/v1/lists/next?location={location}&employeeId={employeeId} | 200 OK, 204 No Content, 400 Bad Request, 500 Internal Server Error |
| Mark item as collected / unavailable        | PUT    | /api/v1/list/{listId}/item/{itemId}                            | 200 OK, 400 Bad Request, 404 Not Found, 500 Internal Server Error  |
| Export lists payment data to Payment Engine | POST   | /api/v1/list/{listId}/export                                   | 200 OK, 400 Bad Request, 500 Internal Server Error                 |

Redundancy:
- Multiple instances of the Lists Service behind a load balancer to ensure high availability and load balancing

### Lists Database
What it does:
- stores the lists and their statuses
- provides data access for Lists Receiver and Lists Service
- supports partitioning and archiving strategies to handle data volume
- supports high availability and redundancy

Application Type: Database
Technology Stack:
- Considerations: should be able to handle high volume of data, should support partitioning and archiving strategies, should support high availability and redundancy
- Client Development Team preferred technology: MySQL
- Chosen Technology: MySQL is a good fit for the database as it supports partitioning
- Final Technology Stack: MySQL

Architecture:
- MySQL database with partitioning and archiving strategies to handle data volume
- Master-Slave replication for high availability and redundancy
- Read Replicas to offload read operations from the master database
- Backup and Recovery strategies to ensure data integrity

### Tablet Application
What it does:
- displays shopping list to employees
- mark items as unavailable or collected
- sends lists to Lists Service and receives updates
- supports offline mode

Application Type: Web Based Application
- Need to decide between:

| Desktop, windows-based application               | Web-based (Electron, React Native, etc)                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| PRO: Supports all OS functinalities              | CON: Limited functionality (not acutally a limitation for the app we require) |
| PRO: Utilizes other apps on the machine (eg. DB) | CON: Cannot use other apps                                                    |
| CON: Requires complex setup and Windows          | PRO: Fully compatible with other form factors (phones, etc.)                  |
|                                                  | PRO: No setup required                                                        |
|                                                  | PRO: Cheaper hardware                                                         |
- Final Decision: Web-based application using React Native for cross-platform compatibility and ease of deployment

### Lists Data Queue
What it does:
- used to send shopping list data to the payement system
- basically a queue where the Lists Service pushes the data and the Payment Engine pulls it

Questions:
- is there an existing queuing system in place? - YES
- should we use the same queuing system as for the Lists Receiver? - YES, there is no reason to have multiple queuing systems
