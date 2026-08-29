# ADR-0005: Intake selection is conversational (LLM classification)

Luna elicits the learner's goal through a free-spoken English conversation, then an LLM
classifies it into a Scenario and fills the Slots, rather than presenting a scenario-chooser
UI. This preserves the "speak with Luna" experience the product is built around. The strict
JSON-schema output (`{ scenarioId, slots, confidence }`) keeps classification deterministic
enough to drive the flow.
