# POSA (Pattern-Oriented Software Architecture)

- set of design patterns for developing software systems that can scale and adapt to changing requirements.
- these patterns were first described in the book “Patterns of Scalable, Reliable Services” by Kevin Hoffman.

POSA patterns are divided into four categories:

- Partitioning Patterns
- Placement Patterns
- Routing Patterns
- Federation Patterns

## Partitioning Patterns

- focus on dividing a system into smaller, manageable components or subsystems

- Decomposition: Breaks a system into smaller, independent components or services based on functionality or domain boundaries.
  Example: Splitting a monolithic application into microservices.
- Layered Partitioning: Divides the system into layers, where each layer has a specific responsibility and interacts only with adjacent layers.
  Example: Presentation, Business Logic, and Data Access layers.
- Horizontal Partitioning: Splits the system into multiple instances of the same functionality, often for scalability.
  Example: Sharding a database by user ID.
- Vertical Partitioning: Divides the system into distinct subsystems based on functionality or domain.
  Example: Separating an e-commerce system into catalog, payment, and order management services

## Placement Patterns

- deal with where and how components or data are deployed in a distributed system.

- Centralized Placement: Places all components or data in a single location to simplify management but may create bottlenecks.
  Example: A single database server for all users.
- Replicated Placement: Duplicates components or data across multiple locations to improve availability and fault tolerance.
  Example: Replicating a database across multiple regions.
- Distributed Placement: Spreads components or data across multiple locations to reduce latency and improve scalability.
  Example: Deploying microservices in different geographic regions.
- Proximity Placement: Places components or data close to where they are most frequently used to reduce latency.
  Example: Caching frequently accessed data at the edge.

## Routing Patterns

- focus on how requests or data are directed through a system.

- Client-Side Routing: The client determines the destination of a request and sends it directly.
  Example: A load balancer implemented in the client application.
- Server-Side Routing: A central server or load balancer determines the destination of a request.
  Example: NGINX or HAProxy directing traffic to backend servers.
- Content-Based Routing: Routes requests based on the content or metadata of the request.
  Example: An API gateway routing requests to different microservices based on the URL path.
- Dynamic Routing: Adjusts routing decisions in real-time based on system conditions, such as load or failures.
  Example: A service mesh like Istio dynamically routing traffic between services.

## Federation Patterns

- address how multiple independent systems or components collaborate while maintaining autonomy.

- Broker Federation: Uses a broker to mediate communication between independent systems.
  Example: A message broker like RabbitMQ or Kafka connecting multiple services.
- Hierarchical Federation: Organizes systems into a hierarchy, where higher-level systems coordinate lower-level systems.
  Example: A master-slave database replication setup.
- Peer-to-Peer Federation: Allows systems to communicate directly with each other without a central coordinator.
  Example: A peer-to-peer file-sharing network like BitTorrent.
- Service Federation: Combines multiple independent services into a unified interface while maintaining their autonomy.
  Example: A federated GraphQL API that aggregates data from multiple services.
