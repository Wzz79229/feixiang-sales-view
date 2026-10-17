# 飞象销售 · GitHub Pages 公开展示版

本目录是无需构建的静态网页。页面提供商品查询、门店/销量/匹配状态筛选、默认顺序及价格/销量/估算销售额排序，以及门店、大小类目和商品维度的可视化分析。

本版商品图片、价格和销量公开可访问；原始完整程序与数据库仍保存在私有仓库 [feixiang-sales-web](https://github.com/Wzz79229/feixiang-sales-web)。上传识别、数据修改、匹配审核在本地完整版使用。本页面不提供写入接口，也不自动调用第三方平台。

## 访问与运行

将 `index.html`、`styles.css`、`app.js`、`favicon.svg`、`.nojekyll`、`data/catalog.json` 和 `images/` 一同部署到 GitHub Pages。所有数据和资源使用相对路径，可部署在仓库子路径下。

本地预览可在此目录运行 `python -m http.server 8766 --bind 127.0.0.1`，再访问 `http://127.0.0.1:8766/`。不要通过 `file://` 直接打开，因为浏览器会阻止数据载入。导航为 `#products` 和 `#analysis`。

## 展示与统计规则

- 飞象商品按 SPU 合并成一个商品组，组内完整保留所有 SKU 的规格和各店数据；查询命中一个规格时仍展示全组规格。
- 只有同一商品记录中已经确认关联的多店报价才出现在同一行。候选不合并，不能据此推断同款价格或销量差。
- 未确认的其他门店商品在“他店待匹配”中查看。门店筛选只改变命中商品组，保留各店列以便比较。
- 默认排序保留导入批次/截图中的商品顺序；相同 SPU 采用组内最早顺序。未知价格和销量排在已知数值后。
- 金额使用整数分计算，显示两位小数。优惠优先级为神价、超值单品、折扣，店铺券到手价不作为单品优惠价。
- 未知数字不会自动补 0。`已知销量为 0`要求选定门店范围内所有规格销量均为已知 0；`销量未知`包括没有已知正销量、但部分规格销量缺失的商品，缺失不会当成 0。
- 估算销售额为月销量乘以当前比较价（有单品优惠用优惠，否则用原价），不是实际成交收入。未知任一项则不计入金额；“≥”仅标注销量下限。含月售下限时按下限数值估算金额，不代表收入下限，条件价和起价也不保证实际成交价。
- 分析按门店商品记录汇总，多个 SKU 分别计入；类目按主类目归集，每条记录只计一次。侧边栏可同时查看大类目与其小类目。
- 各门店截图时间、商品覆盖范围可能不同。“各店全部商品”包含未匹配商品，适合观察收录商品结构；“已确认同款”只统计当前所选门店至少两店已确认的同款。
- 网页是发布时的数据快照，不自动同步本地数据库。需要重新导出并发布才能更新。

## 数据格式与验证

`data/catalog.json` 使用 `schema_version: 1`。商品主图仅允许 `images/` 下的相对路径。动态字段会转义后插入 HTML，页面不加载外部依赖或 CDN。

`app.js` 将纯逻辑导出为浏览器的 `window.FeixiangView`，也可在 Node.js 中 `require('./app.js')` 验证。主要函数：

- `createGroups(products, fxStoreId)`：SPU 归组，候选与确认状态隔离。
- `filterGroups(groups, {library,major,minor,query,storeId,match,sales})`：按商品组筛选并保留所有规格。
- `sortGroups(groups, mode, storeId)`：默认顺序、销量、金额、最低售价、门店数排序。
- `commonProducts(products, storeIds)`：选定门店至少两店已确认同款。
- `aggregateStores(products, stores)` / `aggregateCategories(products, stores, majorOnly)`：未知值与下限透明的统计。
- `formatMoney(cents)` / `offerAmount(offer)`：整数分显示与估算金额计算。
- `queryMatches(product, query)`：名称、规格、条码、SPU、SKU 的分词全部命中查询。

不要将登录信息、浏览器配置、原始数据库或 OAuth 凭据复制到此公开目录。
