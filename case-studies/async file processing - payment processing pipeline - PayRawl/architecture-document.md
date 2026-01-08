# PayRawl - Payment Processing System
> FROM: "Software Architecture Case Studies" on Udemy

## Overview
The PayRawl system is a payment processing system that handles payment files from various sources, validates and processes them, and sends instruction files to banks for payment execution. The system operates fully automatically without any user interface.

### Bulleted Summary
- payment processing system
- receives files from various sources
- validates and processes the files
- send instruction files to banks
- fully automatic, no UI

## Requirements
### Functional Requirements (What the system should do)
- receives file to be processed
- validate and process file
- works with various file formats
- perform various calculations on the file
- create bank payment file
- put the payment file in a designated folder
- keep log of all the activity for 7 years

### Non-Functional Requirements (What the system should deal with)
What we ask?
- how many files are expected to be processed per day? ~500 files/day
- how long should the process take? ~1 min
- what is the average size of a file? ~1MB
- can we tolerate data loss? Absolutely not

Data Volume
- 1 file =~ 1 MB
- 500 files/day =~ 500 MB/day
- 15000 files/month =~ 15 GB/month
- 180000 files/year =~ 180 GB/year
- 1260000 files/7 years =~ 1.3 TB/7 years

Data Volume - Logs
- assuming each processing generates 500 KB of logs
- each step in the processing generates a log entry (validating, processing, creating bank file, etc)
- 1 file =~ 500 KB logs
- 500 files/day =~ 250 MB/day
- 15000 files/month =~ 7.5 GB/month
- 180000 files/year =~ 95 GB/year
- 1260000 files/7 years =~ 640 GB/7 years

Non-Functional Requirements Summary
- 500 files/day
- NO DATA LOSS
- 1 min processing time
- Activity logs kept for 7 years
- Yearly data volume =~ 180 GB + 95 GB = 275 GB/year
- 7 years data volume =~ 1.3 TB + 640 GB =~ 2 TB/7 years

## Executive Summary

## Components
Based on [the requirements](#requirements), the following components can be identified for the PayRawl system:
- Folders (source of files to be processed, destination of bank files) - out of scope of the system
- File Handler - gets files from folders, stores the files in the Files Queue
- Files Queue - queues files to be processed
- File Formatters - various formatters to handle different file formats
  - converts files to unified format
- Formated Files Queue - queues formatted files to be processed
- File Calculation - performs calculations on the formatted files
- Calculated Files Queue - queues calculated files to be processed
- File Exporter - creates bank payment files, puts them in the designated bank folder
- Logs Database - stores logs of all activities for 7 years

### Messaging System
- Queues between components to decouple them and allow for scalability
- No REST API as the system is fully automatic and has no user interface

### The Queue
- there are 3 queues in the system:
  - Files Queue - between File Handler and File Formatters
  - Formated Files Queue - between File Formatters and File Calculation
  - Calculated Files Queue - between File Calculation and File Exporter
- role of the queues:
  - pass payloads from one logic unit to another
  - balances load between components
  - persists messages providing fault tolerance and durability
  - provides asynchronous communication
    - this is important since we do not have UI and the system is fully automatic
  - decouple components
  - allow for scalability
  - buffer files in case of high load
- which queue technology to use?
  - RabbitMQ, AWS SQS, Apache Kafka, etc
  - any reliable queuing system that provides durability and fault tolerance

| RabitMQ                                 | AWS SQS               | Apache Kafka                      |
| --------------------------------------- | --------------------- | --------------------------------- |
| Easy to set up and use                  | Fully managed service | More complex to set up and manage |
| Good for traditional messaging patterns | Scalable and reliable | High throughput and low latency   |
| Supports various messaging patterns     | Pay-as-you-go pricing | Distributed by design             |

Choice:
- the system does not have very high throughput requirements and not streaming data
- we need a simple to set up and use solution
- we choose RabbitMQ as the queuing system for PayRawl

## Components Drill-Down

### File Handler
What it does:
- pulls paymenet files from designated folder
- puts files in the Files Queue for processing

Application Type: Service (continously running application, no HTTP interface)
Technology Stack:
- Considerations
  - should be able to pull files from folder
  - should be able to connect to the queue
- Client: "This is a brand new compnay, we do not have any existing knowledge base or technology stack. What would you recommend?" (any Software Architect would love to hear that question) 
- What are we looking for?
  - performance
  - community support
  - cross-platform support
  - easy to learn and use
  - an evolving technology with good future prospects and strong organisation behind it
  - great therading support
- Candidates:
  - Java
  - Node.js (it is mainly for web applications, not the best fit for this type of application such as a service)
  - .NET Core
- Performance: .NET Core > Java
- Community Support: Java > .NET Core
- Cross-Platform Support: Tie
- Easy to Learn and Use: .NET Core > Java
- Future Prospects and Strong Organisation: Tie
- Threading Support: Java > .NET Core
- Decision: .NET Core is chosen for its performance and ease of use
- Final Technology Stack: .NET Core

Architecture:
- File Watcher Module: monitors designated folder for new files
- Topic Publisher Module: connects to the Files Queue and publishes files for processing
- Files Queue: RabbitMQ queue to hold files for processing

Redundancy and High Availability:
- multiple instances of File Handler running concurrently using the "Is Alive" mechanism to ensure high availability
  - "Is Alive" mechanism - a simple technique where multiple instances of an application run concurrently, but only one instance is active at a time
  - if the active instance fails, another instance takes over

### File Formatters
What it does:
- retrieves files from the Files Queue
- determines the file format
- converts files to unified format used by the system
- puts formatted files in the Formated Files Queue
- new formatters will be added in the future as needed

Application Type: Service (continously running application, no HTTP interface)
Technology Stack:
- Considerations: should be able to connect to the queue, should be easy to add new formatters in the future
- Decision: .NET Core is chosen for consistency with File Handler and ease of use

Architecture:
- Queue Consumer Module: connects to the Files Queue and retrieves files for processing
- Formatters Module: contains various formatters to handle different file formats
  - each formatter implements a common interface for consistency
- Topic Publisher Module: connects to the Formated Files Queue and publishes formatted files for further processing
- Files Queue: RabbitMQ queue to hold files for processing
- Formated Files Queue: RabbitMQ queue to hold formatted files for further processing

Redundancy and High Availability:
- use Consumer Group pattern with multiple instances of File Formatters to ensure high availability and load balancing
  - Consumer Group - concept found in messaging systems like Kafka, where multiple instances of a consumer application work together to consume messages from a topic
  - basically it is a load balancer implemented by the queue mechanism itself

### File Calculation
What it does:
- receives formatted files from the Formated Files Queue
- performs various calculations on the files as per business rules
- puts calculated files in the Calculated Files Queue

Quite similar to File Formatters in terms of architecture and technology stack
  - Technology Stack: .NET Core
  - Architecture:
    - Queue Consumer Module: connects to the Formated Files Queue and retrieves formatted files for processing
    - Calculation Module: performs various calculations on the formatted files
    - Topic Publisher Module: connects to the Calculated Files Queue and publishes calculated files for further processing
    - Formated Files Queue: RabbitMQ queue to hold formatted files for further processing
    - Calculated Files Queue: RabbitMQ queue to hold calculated files for further processing

Redundancy and High Availability:
- use Consumer Group pattern with multiple instances of File Calculation to ensure high availability and load balancing
  - Consumer Group - concept found in messaging systems like Kafka, where multiple instances of a consumer application work together to consume messages from a topic
  - basically it is a load balancer implemented by the queue mechanism itself

### File Exporter
What it does:
- receives calculated files from the Calculated Files Queue
- creates bank payment files as per bank specifications
- puts the bank payment files in the designated bank folder

Quite similar to File Formatters and File Calculation in terms of architecture and technology stack
  - Technology Stack: .NET Core
  - Architecture:
    - Queue Consumer Module: connects to the Calculated Files Queue and retrieves calculated files for processing
    - Exporter Module: creates bank payment files as per bank specifications
    - Bank Folder Module: puts the bank payment files in the designated bank folder
    - Calculated Files Queue: RabbitMQ queue to hold calculated files for further processing

Redundancy and High Availability:
- use Consumer Group pattern with multiple instances of File Exporter to ensure high availability and load balancing
  - Consumer Group - concept found in messaging systems like Kafka, where multiple instances of a consumer application work together to consume messages from a topic
  - basically it is a load balancer implemented by the queue mechanism itself

### Logging Service
What it does:
- writes a log of log records to the Logs Database
- allows easy visualizations and analytics
- preferably - based on an existing platform

Most known platform: Elastic Stack
- Elastic Search - Search and analytics engine
- Kibana - Visualization and analytics platform
- Logstash - Data collection pipeline tool
- Beats - Lightweight log shippers (similar to Logstash, but lightweight and less complex)
- How it works:
  - Elastic Search stores your logs
  - Kibana displays the logs
  - Logstash/Beats collect and ship the logs to Elastic Search (these are the transport mechanisms)

How do we ship logs from .NET Core applications to Elastic Stack?
- use Serilog logging library with Elastic Search sink
- Serilog is a popular logging library for .NET applications
- Elastic Search sink allows sending logs directly to Elastic Search
- each component (File Handler, File Formatters, File Calculation, File Exporter) will use Serilog to log activities to Elastic Search
How do we ship logs from RabbitMQ to Elastic Stack?
- use Logstash RabbitMQ input plugin to pull logs from RabbitMQ and ship them to Elastic Search
- Logstash will connect to RabbitMQ, retrieve log messages, and send them to Elastic Search