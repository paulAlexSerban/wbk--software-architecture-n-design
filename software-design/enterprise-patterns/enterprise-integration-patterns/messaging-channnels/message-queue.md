- Type: Messaging Pattern (Messaging Channel)
- Purpose: Provides a queue for asynchronous communication between components. Producers send messages to the queue, and consumers retrieve them at their own pace.
- Use Case: When you need to decouple systems and ensure reliable message delivery, even if one system is temporarily unavailable.
- Example:
  A task queue for background job processing (e.g., Celery with RabbitMQ).
  Amazon SQS (Simple Queue Service).
