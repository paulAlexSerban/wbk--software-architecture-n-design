# Architecture Document: Leaderboard Application

## Overview
The application is designed to provide a real-time leaderboard for users based on their scores. It consists of a backend service responsible for server-side rendering (SSR) of the leaderboard page, fetching data from a database, and serving API endpoints for both the leaderboard and user data.

**Business Context**
- Industry: Online Gaming
- Business Model: Freemium with in-app purchases
- Current State: MVP with basic leaderboard functionality
- Goal: Scale to millions of users while maintaining performance and reliability
- Target Users: Gamers looking to compete and track their rankings

**System Characteristics**
- High Read-to-Write Ratio: The leaderboard will be read frequently, but updates to user scores will be less frequent.
- Real-Time Updates: Users expect to see their rankings update in real-time as they play.
- Scalability: The system must handle a large number of concurrent users and requests without degradation in performance.
- Data Consistency: The leaderboard must reflect accurate rankings based on user scores, even under high load.
- Security: User data must be protected, and the system should prevent unauthorized access.

## Requirements
1. **Functional Requirements**
   - The system must render the leaderboard page on the server side.
   - The system must fetch user and leaderboard data from a database.
   - The system must provide API endpoints for fetching leaderboard and user data in JSON format.
   - The system must handle user profile pages with detailed information.
   - The system must provide a not-found page for invalid user requests.
   - The system must allow for easy addition of new features in the future.
   - The system must be containerized for easy deployment.
2. **Non-Functional Requirements**
   - The system must be highly performant, with low latency for page rendering and API responses.
   - The system must be scalable to handle millions of users.
   - The system must be reliable, with minimal downtime and robust error handling.
   - The system must be secure, protecting user data and preventing unauthorized access.
   - The system must be maintainable, with clean code and clear documentation.
   - The system must be testable, with unit and integration tests to ensure functionality and performance.
   - The system must be compatible with modern web browsers and devices.

## Tech Stack
- Node.js 24
- JavaScript + Express.js
- JSON file storage via built-in `fs` module
- Handlebars (`express-handlebars`) for SSR templates
- Yarn for dependency management
- Docker + Docker Compose for containerization

## Endpoints

| Functionality     | HTTP Method | Endpoint           | Return Codes                           | Description                                               |
| ----------------- | ----------- | ------------------ | -------------------------------------- | --------------------------------------------------------- |
| Leaderboard Page  | GET         | `/`                | 200 OK                                 | Renders the leaderboard page with the latest data.        |
| Users Page        | GET         | `/users`           | 200 OK                                 | Renders the users page with the list of users.            |
| User Profile Page | GET         | `/users/:id`       | 200 OK, 404 Not Found                  | Renders the user profile page for a specific user.        |
| Get Leaderboard   | GET         | `/api/leaderboard` | 200 OK                                 | Fetches the leaderboard data in JSON format.              |
| Get Users         | GET         | `/api/users`       | 200 OK                                 | Fetches the list of users in JSON format.                 |
| Get User by ID    | GET         | `/api/users/:id`   | 200 OK, 404 Not Found                  | Fetches the user data for a specific user in JSON format. |
| Create User       | POST        | `/api/user`        | 201 Created, 400 Bad Request           | Creates a new user with the provided data.                |
| Update User       | PUT         | `/api/user/:id`    | 200 OK, 400 Bad Request, 404 Not Found | Updates the user data for a specific user.                |
| Delete User       | DELETE      | `/api/user/:id`    | 200 OK, 404 Not Found                  | Deletes a specific user from the database.                |

## Data Models
- **User**: Represents a user in the system with properties such as `id`, `name`, `score`, `rank`, `firstName`, `lastName`, `address`, `email`, `phone`, `website`, and `company`.
```json
{
  "id": 1,
  "name": "Leanne Graham",
  "score": 1500,
  "rank": 1,
  "firstName": "Leanne",
  "lastName": "Graham",
  "address": {
    "street": "Kulas Light",
    "suite": "Apt. 556",
    "city": "Gwenborough",
    "zipcode": "92998-3874"
  },
  "email": "Sincere@april.biz",
  "phone": "1-770-736-8031 x56442",
  "website": "hildegard.org",
  "company": {
    "name": "Romaguera-Crona",
    "catchPhrase": "Multi-layered client-server neural-net",
    "bs": "harness real-time e-markets"
  }
}
```

- **Leaderboard**: Represents the leaderboard with properties such as `entries` (array of `LeaderboardEntry`) and `lastUpdated`.
```json
{
  "entries": [
    {
      "userId": 1,
      "score": 1500,
      "rank": 1
    },
    {
      "userId": 2,
      "score": 1200,
      "rank": 2
    }
  ],
  "lastUpdated": "2024-06-01T12:00:00Z"
}
```

## Shift-Left
### Testing
- **Unit Tests**: Implement unit tests for all controllers, models, and utility functions using a testing framework like Jest. This ensures that individual components work as expected.
- **Integration Tests**: Implement integration tests to verify that different components of the system work together correctly. This includes testing API endpoints and database interactions
  - if neede use Test Containers to spin up a temporary database instance for testing purposes.
- **End-to-End Tests**: Implement end-to-end tests using a tool like Cypress to simulate user interactions with the application and verify that the entire system functions correctly from the user's perspective.
- **Performance Tests**: Implement performance tests to ensure that the application can handle a high load of concurrent users and requests without degradation in performance.
- **Security Tests**: Implement security tests to identify and mitigate potential vulnerabilities in the application, such as SQL injection, cross-site scripting (XSS), and unauthorized access.

## Shift-Right
### Monitoring and Observability
- **Logging**: Implement structured logging using a library like Winston or Bunyan to capture detailed logs of application events, errors, and user interactions. This will help in debugging and understanding application behavior.
- **Metrics**: Implement metrics collection using a tool like Prometheus to track key performance indicators (KPIs) such as request latency, error rates, and user activity. This will help in monitoring the health and performance of the application.
- **Alerting**: Set up alerting using a tool like Grafana or PagerDuty to notify the development team of critical issues, such as high error rates or performance degradation, so that they can be addressed promptly.
- **Fitness Functions**: Define fitness functions to evaluate the health and performance of the application based on the collected metrics. This can include thresholds for acceptable latency, error rates, and user activity levels.
- **CWV Monitoring**: Implement monitoring for Core Web Vitals (CWV) to ensure that the application provides a good user experience in terms of loading performance, interactivity, and visual stability. This can be done using tools like Lighthouse or Web Vitals.