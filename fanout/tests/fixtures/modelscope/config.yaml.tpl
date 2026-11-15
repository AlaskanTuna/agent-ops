port: __PORT__
providers:
  - name: modelscope
    baseUrl: https://api-inference.modelscope.ai/v1
    api-keys:
      - ms-test-key
    models:
      - name: Qwen/Qwen3.8-27B
        alias: ms-qwen3.8-27b
      - name: Qwen/Qwen3.8-57B
        alias: ms-qwen3.8-57b
  - name: openrouter
    baseUrl: https://openrouter.ai/api/v1
    api-keys:
      - or-test-key
    models:
      - name: z-ai/glm-5.3-flash
        alias: glm-5.3-flash
