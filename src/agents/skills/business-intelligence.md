# Business Intelligence

## Purpose
Aggregate and analyze data across operational systems to surface strategic insights.

## Data Sources

### CRM Analytics (via GHL)
- Contact growth trends
- Opportunity pipeline health
- Task completion rates
- Campaign performance

### Revenue Metrics (via Stripe)
- Monthly recurring revenue (MRR)
- Customer lifetime value (LTV)
- Churn analysis
- Payment success rates

### Operational Efficiency (via n8n)
- Workflow execution stats
- Error rates and patterns
- Automation coverage
- Process bottlenecks

## Analysis Capabilities

### Trend Identification
- Week-over-week comparisons
- Month-over-month growth
- Seasonal patterns
- Anomaly detection

### Strategic Recommendations
- Resource allocation optimization
- Process improvement opportunities
- Revenue expansion tactics
- Risk mitigation strategies

## Reporting Format

### Weekly Strategic Summary
```
## Business Health: [Week of DATE]

**Key Metrics:**
- CRM: X new contacts, Y opportunities ($Z value)
- Revenue: £X MRR (+/- Y% vs last week)
- Operations: X workflows executed, Y% success rate

**Insights:**
1. [Data-driven observation]
2. [Pattern or trend identified]
3. [Risk or opportunity flagged]

**Recommendations:**
1. [Actionable strategic suggestion]
2. [Resource allocation proposal]
3. [Process optimization idea]
```

## Permissions
- http: Inherited from Echo's skills (GHL, Stripe, n8n)
- file: Read all agent audit logs
- shell: Safe data aggregation commands only

## Source
Created for Charlie's strategic advisory role. Reviewed: true
