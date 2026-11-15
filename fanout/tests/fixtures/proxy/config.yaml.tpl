# Synthetic test fixture. No real credentials: the token below is a placeholder
# shorter than 20 characters so the hygiene scan stays quiet. `__PORT__`
# is replaced with the fake proxy's port at test time.
port: __PORT__
api-keys:
  - "px-tpl-0"
providers:
  - name: openrouter
    baseUrl: https://openrouter.ai/api/v1
    models:
      - name: meta/muse-spark-1.3-contributor
        alias: muse-spark-1.3
      - name: z-ai/glm-5.3-flash
        alias: glm-5.3-flash
      - name: acme/mystery-model
        alias: mystery
      - name: qwen/qwen3.7-flash
        alias: qwen3.7-flash
  - name: river
    baseUrl: https://api.river.example/v1
    models:
      - name: deepseek-ai/DeepSeek-V4.1-Flash
        alias: deepseek-v4.1-flash-river
      - name: z-ai-org/GLM-5.3-Flash
        alias: glm-5.3-flash-river
