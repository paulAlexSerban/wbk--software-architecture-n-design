# Relational Database

- Data - a collection of facts (numbers, words, measurements, observations, etc) that can be processed into information.
- Database - a collection of data that is stored in a computer system.
- Relational Database - a database that organizes information into one or more tables (or "relations") of columns and rows, with a unique key identifying each row. Generally, each table represents one "entity type" (such as customer or product).

## Database Table

| Column Name | Data Type | Description                      |
| ----------- | --------- | -------------------------------- |
| id          | INT       | Unique identifier for the record |
| name        | VARCHAR   | Name of the record               |
| age         | INT       | Age of the record                |

## Concepts

- Primary Key - a unique identifier for each record in a table.
- Foreign Key - a field in a table that links to the primary key of another table.
- Index - a data structure that improves the speed of data retrieval operations on a database table.
- Normalization - the process of organizing the columns (attributes) and tables (relations) of a relational database to minimize data redundancy.
- Denormalization - the process of adding redundant data to a database to improve read performance.

| Student ID | First Name | Last Name | Birth Date | Email      | Dept Code | Score | City     |
| ---------- | ---------- | --------- | ---------- | ---------- | --------- | ----- | -------- |
| 1          | Alice      | Smith     | 1990-01-01 | as@abc.com | M01       | 90    | New York |
| 2          | Bob        | Johnson   | 1991-02-02 | bj@abc.com | P08       | 85    | Chicago  |
| 3          | Charlie    | Brown     | 1992-03-03 | cb@abd.com | M01       | 95    | Boston   |

Eg. Query:

```sql
SELECT * FROM Students WHERE Score > 90;
```
```sql
UPDATE Students SET City = 'Los Angeles' WHERE City = 'LA'
```

## Relationships
- one-to-many - a relationship where one record in a table can be associated with one or more records in another table.
- many-to-many - a relationship where one or more records in a table can be associated with one or more records in another table.
- one-to-one - a relationship where one record in a table is associated with only one record in another table.
- self-referencing - a relationship where a record in a table is related to itself.
- recursive - a relationship where a record in a table is related to another record in the same table.