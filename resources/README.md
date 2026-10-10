# resources/ —— 字形映射表（题库字体反爬用）

| 文件 | 作用 |
| --- | --- |
| `table.json` | 可读的**源表**（20902 条「32 位哈希 → Unicode 码点」，347 KB）。**要改就改这个** |
| `table.bin` | 打包后的**产物**（122 KB）—— 扩展真正加载的是它，加载后不用解析 JSON |

两个必须保持一致，由 `node tools/table-pack.js` 负责：

```bash
node tools/table-pack.js --pack      # table.json → table.bin
node tools/table-pack.js --verify    # 校验两者一致（npm test 会调，不一致即失败）
node tools/table-pack.js --unpack    # table.bin → table.json（还原成可读文本，用于维护）
node tools/table-pack.js --stats     # 只打印统计
```

> ⚠️ **改了 `table.json` 一定要跑 `--pack`**，否则 `npm test` 会红在
> 「字形映射表 bin/json 不同步」那一条。
>
> 这张表占掉扩展体积的大头 —— 为什么这么大、还能怎么省，见根目录 `README.md` §12。
