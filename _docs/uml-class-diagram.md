# UML - Class Diagram
- used to illustrate structure
- used to construct and vizualize object oriented relationships

Captured information:
1. Class information such as:
    - attributes
    - operations (methods)

```mermaid
classDiagram
    class Shape {
        + color : Color
        + location : Location

        + getArea() : double
        + getColor:() : Color
        + getLocation() : Location
    }
    <<abstract>> Shape
```
2. Class relationships:
a. generalization - eg. inheritance between classes
```mermaid
classDiagram
direction RL
    class Shape {
        + color : Color
        + location : Location

        + getArea() : double
        + getColor:() : Color
        + getLocation() : Location
    }
    <<abstract>> Shape

    class Circle {
        + radius : double
        + getArea() : double
    }
    Circle --|> Shape

    class Rectangle {
        + width : double
        + height : double
        + getArea() : double
    }
    Rectangle --|> Shape
    class Triangle {
        + base : double
        + height : double
        + getArea() : double
    }
    Triangle --|> Shape
```
b. association - eg. a class has a reference to another class
```mermaid
classDiagram
direction RL
    class Shape {
        + color : Color
        + location : Location

        + getArea() : double
        + getColor:() : Color
        + getLocation() : Location
    }
    <<abstract>> Shape

    class Circle {
        + radius : double
        + getArea() : double
    }
    Circle --|> Shape


    class Rectangle {
        + width : double
        + height : double
        + getArea() : double
    }
    Rectangle --|> Shape

    class Cylinder {
        + radius : double
        + height : double
        + getArea() : double
    }
    Cylinder --|> Shape
    Cylinder *--> "3..3" Shape

    note for Cylinder "A cylinder is a 3D shape. It has 3 shapes: 2 circles (top and bottom), 1 rectangle (side)"
```

c. dependency - eg. a class uses another class
```mermaid
classDiagram
    direction RL
    class Shape {
        + color : Color
        + location : Location

        + getArea() : double
        + getColor:() : Color
        + getLocation() : Location
    }
    <<abstract>> Shape

    class Calculator {
        + calculateArea(shape: Shape) : double
    }

    Shape <.. Calculator

```

### House Example
```mermaid
classDiagram
direction RL
    class IRoom
    <<interface>> IRoom

    IRoom <|.. Room

    class Room
    <<abstract>> Room

    class BathRoom
    class LivingRoom
    class BedRoom

    Room <|-- "3..3" BathRoom
    Room <|-- LivingRoom
    Room <|-- "5..5" BedRoom

    class House
    BathRoom *--> House
    LivingRoom *--> House
    BedRoom *--> House

    class ElectricGrid
    House "uses" ..> ElectricGrid

    class Pool
    House o--> Pool

    class Garage
    House *--> "2..2" Door


    class Window
    House *--> "10..10" Window
    class Door
    House *--> Garage
```