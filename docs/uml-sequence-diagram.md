# UML - Sequence Diagram
- used to illustrate the behavior of a system/design
- used to visualize the sequence of messages exchanged between objects
Captures:
1. actors of the operation
2. method calls with data

```mermaid
sequenceDiagram
    participant User
    participant Cylinder
    participant Shape

    User->>Cylinder: getArea()
    Cylinder->>Cylinder: areaSum = 0

    loop for each item in elements
        Cylinder->>Shape: getArea()
        Shape->>Cylinder: area: double
        Cylinder->>Cylinder: add to areaSum
    end

    Cylinder->>User: result: double

```