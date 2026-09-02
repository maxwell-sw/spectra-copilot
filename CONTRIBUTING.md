# Contributing

欢迎提出 Bug、功能建议和 Pull Request。

## 本地开发

```bash
npm install
npm test
npm start
```

提交代码前请确保全部测试通过。涉及光谱计算时，请为新的确定性逻辑补充回归测试；涉及模型行为时，不要让模型绕过单位确认、文件授权或可复算的本地计算。

## 提交建议

- 一个 Pull Request 尽量只解决一个问题，并说明用户可观察到的变化。
- 不要提交 API Key、研究数据、浏览器导出、`node_modules` 或 `.spectra-artifacts`。
- 不要将模型生成的数值当作科研事实；数值结论必须来自受控工具。
- 修改旧版 Demo 或其 ASTM 数据前，请说明来源、许可证与验证方法。
