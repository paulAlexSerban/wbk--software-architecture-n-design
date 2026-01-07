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

## Executive Summary

## Components

### Messaging System

### Scaling

## Services Drill Down
