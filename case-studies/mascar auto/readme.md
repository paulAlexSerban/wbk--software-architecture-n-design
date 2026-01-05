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

## Services Drill Down