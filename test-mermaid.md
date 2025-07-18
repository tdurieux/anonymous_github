# Mermaid Test File

## Simple Flowchart
```mermaid
graph TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[🎉 Success!]
    B -->|No| D[Check console]
    D --> B
    C --> E[End]
```

## Sequence Diagram
```mermaid
sequenceDiagram
    participant U as User
    participant A as App
    participant G as GitHub
    
    U->>A: Upload repo
    A->>G: Fetch data
    G-->>A: Repository content
    A->>A: Anonymize
    A-->>U: Show result
```

## Simple Pie Chart
```mermaid
pie title Test Languages
    "JavaScript" : 50
    "CSS" : 30
    "HTML" : 20
```

## State Diagram
```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Processing
    Processing --> Complete
    Complete --> [*]
    Processing --> Error
    Error --> [*]
```

If you can see the diagrams above rendered as interactive graphics (not as code blocks), then Mermaid is working correctly! 