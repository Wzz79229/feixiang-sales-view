(function () {
  'use strict';

  const COLORS = ['#218a78', '#73a2ba', '#d2a15a', '#9d8bb4', '#7fa58e', '#c68b86'];
  const PAGE_SIZE = 40;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const moneyValue = value => Number.isSafeInteger(value) && value >= 0;
  const salesValue = value => finite(value) && value >= 0;
  const text = value => value == null ? '' : String(value);
  const esc = value => text(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalizeSearch = value => text(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const number = value => finite(value) ? value.toLocaleString('zh-CN', {maximumFractionDigits: 2}) : '未知';
  const formatMoney = value => moneyValue(value) ? (value / 100).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '未知';
  const offerPrice = offer => moneyValue(offer && offer.price_cents) ? offer.price_cents : null;
  const offerAmount = offer => offerPrice(offer) !== null && salesValue(offer.sales) ? offerPrice(offer) * offer.sales : null;
  const orderValue = value => finite(Number(value)) ? Number(value) : Number.MAX_SAFE_INTEGER;
  function compareOrder(a, b) {
    const left = Array.isArray(a) ? a : [], right = Array.isArray(b) ? b : [];
    for (let index = 0; index < Math.max(left.length, right.length, 2); index++) {
      const difference = orderValue(left[index]) - orderValue(right[index]);
      if (difference) return difference;
    }
    return 0;
  }
  function categoryPaths(product) {
    const paths = Array.isArray(product.category_paths) ? product.category_paths.filter(path => Array.isArray(path) && path.length >= 2) : [];
    return paths.length ? paths : [[product.major || '未分类', product.minor || '待分类']];
  }
  function categoryMatches(product, major, minor) {
    return !major || categoryPaths(product).some(path => text(path[0]) === major && (!minor || text(path[1]) === minor));
  }
  function productSearchText(product) {
    return normalizeSearch([product.name, product.spec, product.barcode, product.spu, ...(product.offers || []).map(offer => offer.source_sku)].join(' '));
  }
  function queryMatches(product, query) {
    const terms = text(query).normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const haystack = product._search || productSearchText(product);
    return terms.every(term => haystack.includes(normalizeSearch(term)));
  }
  function createGroups(products, fxStoreId) {
    const map = new Map();
    for (const product of products) {
      const isFx = (product.offers || []).some(offer => text(offer.store_id) === text(fxStoreId));
      const key = isFx ? 'fx:' + (product.spu || product.id) : 'pending:' + product.id;
      if (!map.has(key)) map.set(key, {id:key, isFx, spu:isFx ? product.spu : null, variants:[], order:product.order || [], stores:[], candidate_store_ids:[], candidate_count:0, multi_spec:false});
      const group = map.get(key);
      group.variants.push(product);
      if (compareOrder(product.order, group.order) < 0) group.order = product.order;
    }
    for (const group of map.values()) {
      group.variants.sort((a, b) => compareOrder(a.order, b.order) || text(a.id).localeCompare(text(b.id)));
      group.product = group.variants[0];
      group.stores = [...new Set(group.variants.flatMap(product => (product.offers || []).map(offer => text(offer.store_id))))];
      group.candidate_store_ids = [...new Set(group.variants.flatMap(product => product.candidate_store_ids || []).map(text))];
      group.candidate_count = Math.max(0, ...group.variants.map(product => Number(product.candidate_count) || 0));
      group.multi_spec = group.variants.length > 1 || group.variants.some(product => product.multi_spec || (product.offers || []).some(offer => offer.multi_spec));
      group.confirmed = group.variants.some(product => new Set((product.offers || []).map(offer => text(offer.store_id))).size >= 2);
      group.high_candidate = group.variants.some(product => product.candidate_count > 0 && product.candidate_level === 'high');
    }
    return [...map.values()];
  }
  function matchState(group) {
    if (group.confirmed) return 'matched';
    if (group.candidate_count > 0 || group.candidate_store_ids.length) return 'candidate';
    return group.isFx ? 'fx-only' : 'no-candidate';
  }
  function groupOffers(group, storeId) {
    return group.variants.flatMap(product => product.offers || []).filter(offer => !storeId || text(offer.store_id) === text(storeId));
  }
  function salesMatches(offers, mode) {
    if (!mode) return true;
    if (mode === 'with') return offers.some(offer => salesValue(offer.sales) && offer.sales > 0);
    if (mode === 'zero') return offers.length > 0 && offers.every(offer => offer.sales === 0);
    if (mode === 'unknown') return offers.length > 0 && !offers.some(offer => salesValue(offer.sales) && offer.sales > 0) && !offers.every(offer => offer.sales === 0);
    return true;
  }
  function filterGroups(groups, options) {
    const opts = options || {};
    return groups.filter(group => {
      if (opts.library && group.isFx !== (opts.library === 'fx')) return false;
      if (!group.variants.some(product => categoryMatches(product, opts.major, opts.minor) && queryMatches(product, opts.query))) return false;
      if (opts.storeId && !group.stores.includes(text(opts.storeId))) return false;
      const state = matchState(group);
      if (opts.match === 'high-candidate' && !group.high_candidate) return false;
      if (opts.match === 'candidate' && state !== 'candidate') return false;
      if (opts.match && !['candidate', 'high-candidate'].includes(opts.match) && state !== opts.match) return false;
      return salesMatches(groupOffers(group, opts.storeId), opts.sales);
    });
  }
  function groupMetric(group, mode, storeId) {
    const offers = groupOffers(group, storeId);
    if (mode === 'stores') return group.stores.length;
    if (mode === 'price') {
      const known = offers.map(offerPrice).filter(value => value !== null);
      return known.length ? Math.min(...known) : null;
    }
    const known = offers.map(offer => mode === 'amount' ? offerAmount(offer) : salesValue(offer.sales) ? offer.sales : null).filter(value => value !== null);
    return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
  }
  function sortGroups(groups, mode, storeId) {
    return [...groups].sort((a, b) => {
      if (mode && mode !== 'default') {
        const left = groupMetric(a, mode, storeId), right = groupMetric(b, mode, storeId);
        if (left === null && right !== null) return 1;
        if (right === null && left !== null) return -1;
        if (left !== null && right !== null && left !== right) return mode === 'price' ? left - right : right - left;
      }
      return compareOrder(a.order, b.order) || a.id.localeCompare(b.id);
    });
  }
  function commonProducts(products, storeIds) {
    const selected = storeIds ? new Set(storeIds.map(text)) : null;
    return products.filter(product => new Set((product.offers || []).filter(offer => !selected || selected.has(text(offer.store_id))).map(offer => text(offer.store_id))).size >= 2);
  }
  function emptyTotals(store) {
    return {id:text(store.id), name:store.name, offers:0, products:0, sales:0, amount:0, sales_known:0, amount_known:0, price_unknown:0, sales_unknown:0, lower_bound:false};
  }
  function addOffer(total, offer) {
    total.offers++;
    if (salesValue(offer.sales)) { total.sales += offer.sales; total.sales_known++; }
    else total.sales_unknown++;
    if (offerPrice(offer) === null) total.price_unknown++;
    const amount = offerAmount(offer);
    if (amount !== null) { total.amount += amount; total.amount_known++; }
    if (offer.sales_is_lower_bound && salesValue(offer.sales)) total.lower_bound = true;
  }
  function aggregateStores(products, stores) {
    const totals = new Map(stores.map(store => [text(store.id), emptyTotals(store)]));
    for (const product of products) {
      const seen = new Set();
      for (const offer of product.offers || []) {
        const total = totals.get(text(offer.store_id));
        if (!total) continue;
        addOffer(total, offer);
        seen.add(total.id);
      }
      for (const id of seen) totals.get(id).products++;
    }
    return [...totals.values()];
  }
  function aggregateCategories(products, stores, majorOnly) {
    const categories = new Map();
    for (const product of products) {
      const major = product.major || '未分类', minor = majorOnly ? '' : product.minor || '待分类';
      const key = major + '\u0001' + minor;
      if (!categories.has(key)) categories.set(key, {key, major, minor, products:0, stores:stores.map(emptyTotals)});
      const category = categories.get(key);
      category.products++;
      const seen = new Set();
      for (const offer of product.offers || []) {
        const total = category.stores.find(store => store.id === text(offer.store_id));
        if (!total) continue;
        addOffer(total, offer);
        seen.add(total.id);
      }
      category.stores.forEach(store => { if (seen.has(store.id)) store.products++; });
    }
    return [...categories.values()];
  }
  function safeImage(path) {
    return typeof path === 'string' && /^images\/[a-z0-9_-]+\/[a-z0-9_.-]+\.(webp|png|jpe?g)$/i.test(path) && !path.includes('..') ? path : null;
  }
  const API = {formatMoney, offerPrice, offerAmount, compareOrder, normalizeSearch, queryMatches, categoryMatches, createGroups, matchState, salesMatches, filterGroups, sortGroups, groupMetric, commonProducts, aggregateStores, aggregateCategories, safeImage};
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof window !== 'undefined') window.FeixiangView = API;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const state = {page:'products', library:'fx', major:'', minor:'', query:'', storeId:'', match:'', sales:'', sort:'default', currentPage:1, analysisStores:[], analysisScope:'all', analysisMetric:'amount'};
  let catalog, groups = [], groupMap = new Map(), stores = [], fxStoreId = '', visibleGroups = [];
  const storeName = id => (stores.find(store => text(store.id) === text(id)) || {}).name || text(id);
  const storeColor = id => COLORS[Math.max(0, stores.findIndex(store => text(store.id) === text(id))) % COLORS.length];
  const metricKnown = (total, metric) => metric === 'amount' ? total.amount_known > 0 : total.sales_known > 0;
  const metricValue = (total, metric) => metricKnown(total, metric) ? total[metric] : null;
  const metricText = (value, metric, lower) => value === null ? '未知' : (metric === 'sales' && lower ? '≥ ' : '') + (metric === 'amount' ? '¥' + formatMoney(value) : number(value));
  const dateText = value => {
    if (!value) return '来源日期未提供';
    const raw = text(value).replace('T', ' ').replace(/Z$/, ' UTC');
    return raw.length > 19 ? raw.slice(0, 19) : raw;
  };
  function summaryCard(label, value, note, symbol, featured) {
    return '<div class="summary-card' + (featured ? ' featured' : '') + '"><span class="card-label">' + esc(label) + '</span><strong>' + esc(value) + '</strong><span class="card-note">' + esc(note) + '</span><span class="card-symbol" aria-hidden="true">' + symbol + '</span></div>';
  }
  function imageHtml(product, className) {
    const path = safeImage(product.image);
    return path ? '<button type="button" class="image-button" data-image="' + esc(path) + '" data-image-name="' + esc(product.name) + '" aria-label="放大商品图片：' + esc(product.name) + '"><img class="product-image ' + (className || '') + '" src="' + esc(path) + '" alt="' + esc(product.name) + '" loading="lazy" decoding="async"></button>' : '<span class="image-placeholder" role="img" aria-label="暂无商品图片">暂无图片</span>';
  }
  function activityClass(activity) {
    return activity === '神价' ? 'shen' : activity === '超值单品' ? 'value' : 'discount';
  }
  function offerHtml(offer, details) {
    const promotion = moneyValue(offer.promotion_cents) ? offer.promotion_cents : null;
    const original = moneyValue(offer.original_cents) ? offer.original_cents : null;
    const price = offerPrice(offer);
    const activity = ['神价', '超值单品', '折扣'].includes(offer.activity) ? offer.activity : '';
    let html = '<div class="offer">';
    if (promotion !== null && activity) {
      html += '<div class="offer-original">原价 ' + (original !== null ? '<del>¥' + formatMoney(original) + '</del>' : '<span class="offer-unknown">未知</span>') + '</div><span class="badge ' + activityClass(activity) + '">◆ ' + esc(activity) + '</span><strong class="offer-price">¥' + formatMoney(promotion) + (offer.multi_spec ? '<small> 起</small>' : '') + '</strong>';
    } else if (original !== null) {
      html += '<div class="offer-original">原价<strong>¥' + formatMoney(original) + (offer.multi_spec ? '<small> 起</small>' : '') + '</strong></div>';
    } else if (price !== null) {
      html += '<div class="offer-original">售价<strong>¥' + formatMoney(price) + (offer.multi_spec ? '<small> 起</small>' : '') + '</strong></div><div class="offer-note">原价未提供</div>';
    } else html += '<div class="offer-unknown">价格未知</div>';
    if (offer.coupon_excluded) html += '<span class="badge coupon">⊘ 不参加神券</span>';
    html += '<div class="offer-sales">月销量 <strong>' + (salesValue(offer.sales) ? (offer.sales_is_lower_bound ? '≥ ' : '') + number(offer.sales) : '未知') + '</strong></div>';
    if (offer.price_condition) html += '<div class="offer-note">' + esc(offer.price_condition) + '</div>';
    const conflict = Array.isArray(offer.numeric_conflicts) ? offer.numeric_conflicts : [];
    const unconfirmed = Array.isArray(offer.numeric_unconfirmed) ? offer.numeric_unconfirmed : [];
    if (conflict.length || unconfirmed.length) html += '<div class="numeric-warning">' + (conflict.length ? '数值来源有分歧' : '部分数值待核实') + (details ? '：' + esc([...conflict, ...unconfirmed].map(item => typeof item === 'object' ? item.field || item.reason || JSON.stringify(item) : item).join('；')) : ' · 详见详情') + '</div>';
    if (details) html += '<div class="offer-note">SKU：' + esc(offer.source_sku || '未提供') + '</div><div class="offer-note">来源时间：' + esc(dateText(offer.captured_at)) + '</div><div class="offer-note">估算销售额：' + esc(metricText(offerAmount(offer), 'amount', offer.sales_is_lower_bound)) + '</div>';
    return html + '</div>';
  }
  function statusHtml(group) {
    const status = matchState(group);
    if (status === 'matched') return '<span class="badge confirmed">已确认同款</span>' + (group.candidate_count ? '<p>另有候选待确认</p>' : '<p>各门店数据已关联</p>');
    if (status === 'candidate') return '<span class="badge pending">有候选 · 待确认</span><p>' + (group.high_candidate ? '包含高相关候选' : '候选尚未确认同款') + '</p>';
    return '<span class="badge neutral">' + (group.isFx ? '仅飞象' : '暂无候选') + '</span><p>' + (group.isFx ? '尚无其他门店同款' : '保留原门店商品数据') + '</p>';
  }
  function productCell(group) {
    const product = group.product;
    return '<div class="product-cell">' + imageHtml(product) + '<div class="product-copy"><button type="button" class="product-title" data-detail="' + esc(group.id) + '" title="' + esc(product.name) + '">' + esc(product.name || '名称未提供') + '</button><div class="product-meta">' + esc(product.major || '未分类') + ' / ' + esc(product.minor || '待分类') + '</div><div class="product-meta spu">' + (group.isFx ? 'SPU ' + esc(group.spu || '未提供') : '条码 ' + esc(product.barcode || '未提供')) + '</div><div class="store-tags">' + group.stores.map(id => '<span class="store-tag">' + esc(storeName(id)) + '</span>').join('') + '</div>' + (group.multi_spec ? '<div class="badges"><span class="badge multi">▦ 多规格' + (group.variants.length > 1 ? ' · ' + group.variants.length + ' 个 SKU' : '') + '</span></div>' : '') + '</div></div>';
  }
  function renderCategoryTree() {
    const oldOpen = new Set([...$('category-tree').querySelectorAll('details[open]')].map(el => el.dataset.major));
    const base = state.page === 'products' ? groups.filter(group => group.isFx === (state.library === 'fx')) : groups;
    const categories = new Map();
    for (const group of base) {
      const seen = new Set();
      for (const product of group.variants) for (const path of categoryPaths(product)) {
        const major = text(path[0]) || '未分类', minor = text(path[1]) || '待分类';
        if (!categories.has(major)) categories.set(major, {groups:new Set(), minors:new Map()});
        const category = categories.get(major);
        category.groups.add(group.id);
        if (!category.minors.has(minor)) category.minors.set(minor, new Set());
        if (!seen.has(major + '\u0001' + minor)) category.minors.get(minor).add(group.id);
        seen.add(major + '\u0001' + minor);
      }
    }
    const sorted = [...categories].sort((a, b) => b[1].groups.size - a[1].groups.size || a[0].localeCompare(b[0], 'zh-CN'));
    $('category-tree').innerHTML = '<button class="category-all' + (!state.major ? ' selected' : '') + '" type="button" data-major="" data-minor=""><span>全部类目</span><span class="category-count">' + number(base.length) + '</span></button>' + sorted.map(([major, category]) => '<details data-major="' + esc(major) + '"' + (state.major === major || oldOpen.has(major) ? ' open' : '') + '><summary><button type="button" data-major="' + esc(major) + '" data-minor="" class="' + (state.major === major && !state.minor ? 'selected' : '') + '">' + esc(major) + '</button><span class="category-count">' + number(category.groups.size) + '</span></summary><div class="category-children">' + [...category.minors].sort((a,b) => b[1].size - a[1].size || a[0].localeCompare(b[0], 'zh-CN')).map(([minor, ids]) => '<button type="button" data-major="' + esc(major) + '" data-minor="' + esc(minor) + '" class="' + (state.major === major && state.minor === minor ? 'selected' : '') + '"><span>' + esc(minor) + '</span><span class="category-count">' + number(ids.size) + '</span></button>').join('') + '</div></details>').join('');
  }
  function updateMatchOptions() {
    $('match-filter').innerHTML = '<option value="">全部状态</option>' + (state.library === 'fx' ? '<option value="matched">已确认同款</option><option value="candidate">候选 · 待确认</option><option value="fx-only">仅飞象</option>' : '<option value="candidate">候选 · 待确认</option><option value="high-candidate">含高相关候选</option><option value="no-candidate">暂无候选</option>');
    $('match-filter').value = state.match;
  }
  function renderCatalogSummary() {
    const counts = catalog.counts || {}, fxGroups = groups.filter(group => group.isFx), pending = groups.filter(group => !group.isFx);
    $('catalog-summary').innerHTML = summaryCard('飞象 SPU 商品', number(counts.fx_spu ?? fxGroups.length), '同一商品，多种规格合并展示', '▦', true) + summaryCard('飞象 SKU 规格', number(counts.fx_sku ?? fxGroups.reduce((sum,group) => sum + group.variants.length,0)), '保留每个规格的价格与销量', '▤', false) + summaryCard('他店待匹配', number(pending.length), '候选需在本地确认后关联', '⇄', false) + summaryCard('已确认多店同款', number(counts.cross_store ?? catalog.products.filter(product => new Set(product.offers.map(offer => offer.store_id)).size > 1).length), '只合并已经确认的商品', '◇', false);
    $('fx-count').textContent = number(fxGroups.length);
    $('pending-count').textContent = number(pending.length);
  }
  function catalogEmptyHtml() {
    if (state.library === 'fx' && state.storeId && text(state.storeId) !== fxStoreId) return '<span aria-hidden="true">⇄</span><h2>当前范围暂无该门店的已确认同款</h2><p>飞象主商品库只展示已确认关联的数据，匹配候选不会直接合并。可切换到“他店待匹配”查看该门店商品。</p><button type="button" class="secondary" data-switch-pending>查看他店待匹配</button> <button type="button" class="secondary" id="empty-reset">清除筛选</button>';
    return '<span aria-hidden="true">⌕</span><h2>没有找到符合条件的商品</h2><p>试试减少关键词或清除部分筛选。</p><button type="button" class="secondary" id="empty-reset">清除筛选</button>';
  }
  function renderCatalog() {
    if (!catalog) return;
    if (state.page === 'products') {
      $('page-title').textContent = state.library === 'pending' ? '他店待匹配商品' : '飞象主商品库';
      $('page-description').textContent = state.library === 'pending' ? '保留各门店原商品记录；匹配候选请在本地确认，确认同款后再关联到飞象商品。' : '以飞象商品为主，按 SPU 整理规格，在同一行对比各店数据。';
    }
    const options = {library:state.library, major:state.major, minor:state.minor, query:state.query, storeId:state.storeId, match:state.match, sales:state.sales};
    visibleGroups = sortGroups(filterGroups(groups, options), state.sort, state.storeId);
    const pageCount = Math.max(1, Math.ceil(visibleGroups.length / PAGE_SIZE));
    state.currentPage = Math.max(1, Math.min(pageCount, state.currentPage));
    const page = visibleGroups.slice((state.currentPage - 1) * PAGE_SIZE, state.currentPage * PAGE_SIZE);
    $('tab-fx').setAttribute('aria-selected', String(state.library === 'fx'));
    $('tab-pending').setAttribute('aria-selected', String(state.library === 'pending'));
    $('result-count').textContent = number(visibleGroups.length) + (state.library === 'fx' ? ' 个 SPU 商品组' : ' 条他店商品');
    $('category-scope').textContent = state.major ? state.major + (state.minor ? ' / ' + state.minor : '') : '全部类目';
    $('catalog-note').textContent = (state.library === 'fx' ? '筛选命中一个规格时，保留该 SPU 下全部规格；门店列保持完整，方便横向对比。' : '此处保留未确认匹配的原门店商品；有候选不等于已确认同款。') + (state.sales === 'zero' ? '“已知销量为 0”要求所选门店范围内所有规格销量均为已知 0。' : state.sales === 'unknown' ? '“销量未知”包括没有已知正销量、但部分规格销量缺失的商品；缺失不会当成 0。' : '');
    $('product-head').innerHTML = '<tr><th>商品信息</th><th>销售规格</th>' + stores.map(store => '<th>' + esc(store.name) + '</th>').join('') + '<th>匹配状态</th><th>操作</th></tr>';
    let rows = '';
    for (const group of page) group.variants.forEach((product, index) => {
      rows += '<tr class="' + (index === 0 ? 'group-start' : 'variant-row') + '">';
      if (index === 0) rows += '<td class="group-cell" rowspan="' + group.variants.length + '">' + productCell(group) + '</td>';
      const hit = Boolean(state.query) && queryMatches(product, state.query);
      rows += '<td class="spec-cell' + (hit ? ' hit' : '') + '">' + (hit ? '<span class="query-hit">查询命中</span>' : '') + '<b>' + esc(product.spec || '规格未提供') + '</b>' + (product.barcode ? '<div class="sku-label">条码 ' + esc(product.barcode) + '</div>' : '') + (product.offers || []).filter(offer => offer.source_sku).map(offer => '<div class="sku-label">' + (text(offer.store_id) === fxStoreId ? 'SKU ' : esc(storeName(offer.store_id)) + ' SKU ') + esc(offer.source_sku) + '</div>').join('') + '</td>';
      for (const store of stores) {
        const offers = (product.offers || []).filter(offer => text(offer.store_id) === text(store.id));
        rows += '<td class="offer-cell">' + (offers.length ? offers.map(offer => offerHtml(offer, false)).join('') : '<span class="not-present">未收录同款</span>') + '</td>';
      }
      if (index === 0) rows += '<td class="status-cell" rowspan="' + group.variants.length + '">' + statusHtml(group) + '</td><td rowspan="' + group.variants.length + '"><button type="button" class="table-action" data-detail="' + esc(group.id) + '">查看详情</button></td>';
      rows += '</tr>';
    });
    $('product-body').innerHTML = rows;
    $('catalog-empty').hidden = page.length > 0;
    if (!page.length) $('catalog-empty').innerHTML = catalogEmptyHtml();
    $('pagination').hidden = page.length === 0;
    $('pagination').innerHTML = '<span>每页 ' + PAGE_SIZE + ' 个商品组 · 共 ' + number(visibleGroups.length) + ' 个' + (state.library === 'fx' ? ' · 组内规格完整保留' : '') + '</span><div class="pagination-buttons"><button type="button" data-page="1"' + (state.currentPage === 1 ? ' disabled' : '') + '>首页</button><button type="button" data-page="' + (state.currentPage - 1) + '"' + (state.currentPage === 1 ? ' disabled' : '') + '>上一页</button><span class="page-number">' + state.currentPage + ' / ' + pageCount + '</span><button type="button" data-page="' + (state.currentPage + 1) + '"' + (state.currentPage >= pageCount ? ' disabled' : '') + '>下一页</button></div>';
  }
  function analysisProducts() {
    let products = catalog.products.filter(product => categoryMatches(product, state.major, state.minor) && product.offers.some(offer => state.analysisStores.includes(text(offer.store_id))));
    if (state.analysisScope === 'common') products = commonProducts(products, state.analysisStores);
    return products;
  }
  function renderAnalysis() {
    if (!catalog) return;
    const selectedStores = stores.filter(store => state.analysisStores.includes(text(store.id)));
    const products = analysisProducts(), metric = state.analysisMetric, metricName = metric === 'amount' ? '估算销售额' : '月销量';
    const totals = aggregateStores(products, selectedStores);
    const allTotals = aggregateStores(catalog.products, stores);
    $('analysis-coverage').textContent = allTotals.map(total => total.name + '：收录 ' + number(total.offers) + ' 条门店记录，' + number(total.sales_known) + ' 条销量已知，' + number(total.amount_known) + ' 条可估算金额').join('；') + '。数据快照时间：' + dateText(catalog.snapshot_at) + '；逐项来源时间可在商品详情查看。';
    const empty = !selectedStores.length || !products.length;
    $('analysis-empty').hidden = !empty;
    $('analysis-content').hidden = empty;
    if (empty) {
      $('analysis-empty').innerHTML = !selectedStores.length ? '<span aria-hidden="true">▥</span><h2>选择至少一家门店开始分析</h2><p>勾选上方门店，查看销量、估算销售额与品类结构。</p>' : state.analysisScope === 'common' ? '<span aria-hidden="true">⇄</span><h2>当前范围没有已确认的多店同款</h2><p>匹配候选尚未确认，不能用于同款价格与销量比较。在本地确认匹配、重新发布快照后可查看；现在可以先对比各店已收录商品的品类结构。</p><button type="button" class="secondary" data-analysis-all>查看各店全部商品</button>' : '<span aria-hidden="true">▥</span><h2>当前类目没有可分析的商品</h2><p>试试选择其他门店或重置左侧类目。</p><button type="button" class="secondary" data-clear-category>重置类目</button>';
      return;
    }
    const salesKnown = totals.reduce((sum,total) => sum + total.sales_known,0), amountKnown = totals.reduce((sum,total) => sum + total.amount_known,0), offerCount = totals.reduce((sum,total) => sum + total.offers,0), sales = totals.reduce((sum,total) => sum + total.sales,0), amount = totals.reduce((sum,total) => sum + total.amount,0), lower = totals.some(total => total.lower_bound);
    $('analysis-summary').innerHTML = summaryCard('已收录商品记录', number(products.length), selectedStores.length + ' 家门店 · ' + number(offerCount) + ' 条门店记录', '▦', false) + summaryCard('月销量汇总', salesKnown ? (lower ? '≥ ' : '') + number(sales) : '未知', number(salesKnown) + ' / ' + number(offerCount) + ' 条记录销量已知', '▥', false) + summaryCard('估算销售额', amountKnown ? '¥' + formatMoney(amount) : '未知', '月销量 × 当前单品售价 · 非实际营收', '¥', true) + summaryCard('金额数据覆盖率', offerCount ? Math.round(amountKnown / offerCount * 100) + '%' : '—', number(amountKnown) + ' 条可计算 · 未知项不计入', '◔', false);
    $('store-chart-title').textContent = '门店' + metricName;
    $('store-chart-unit').textContent = metric === 'amount' ? '单位：元' : '单位：件 / 月';
    const max = Math.max(0, ...totals.map(total => metricValue(total,metric) || 0));
    $('store-chart').innerHTML = totals.map(total => {
      const value = metricValue(total, metric), width = max > 0 && value !== null ? value / max * 100 : 0;
      return '<div class="store-bar"><div class="store-bar-head"><span class="store-bar-label"><i class="store-color" style="background:' + storeColor(total.id) + '"></i>' + esc(total.name) + '</span><b>' + esc(metricText(value, metric, total.lower_bound)) + '</b></div><div class="bar-track" role="img" aria-label="' + esc(total.name + ' ' + metricName + ' ' + metricText(value,metric,total.lower_bound)) + '"><div class="bar-fill" style="width:' + width.toFixed(2) + '%;background:' + storeColor(total.id) + '"></div></div><small>' + number(total.products) + ' 条商品记录 · ' + number(metric === 'amount' ? total.amount_known : total.sales_known) + ' 条指标已知' + (total.lower_bound ? ' · 含销量下限' : '') + '</small></div>';
    }).join('');
    const majorCategories = aggregateCategories(products, selectedStores, true).map(category => ({...category, value:category.stores.reduce((sum,total) => sum + (metricValue(total,metric) || 0),0), known:category.stores.some(total => metricKnown(total,metric))})).sort((a,b) => b.value-a.value);
    const categoryTotal = majorCategories.reduce((sum, category) => sum+category.value,0);
    $('category-mix').innerHTML = majorCategories.filter(category => category.known).slice(0,6).map((category,index) => {
      const share = categoryTotal > 0 ? category.value / categoryTotal * 100 : 0;
      return '<div class="mix-row"><span title="' + esc(category.major) + '">' + esc(category.major) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + share.toFixed(2) + '%;background:' + COLORS[index % COLORS.length] + '"></div></div><b>' + share.toFixed(1) + '%</b></div>';
    }).join('') || '<p class="store-zero">当前范围内没有已知的' + metricName + '。</p>';
    $('category-mix').innerHTML += '<p class="chart-footnote">按所选门店已知' + metricName + '占比，归入商品主类目。</p>';
    $('category-legend').innerHTML = selectedStores.map(store => '<span><i class="store-color" style="background:' + storeColor(store.id) + '"></i>' + esc(store.name) + '</span>').join('');
    const categories = aggregateCategories(products, selectedStores, false).map(category => ({...category, value:category.stores.reduce((sum,total) => sum + (metricValue(total,metric) || 0),0)})).sort((a,b) => b.value-a.value || a.major.localeCompare(b.major,'zh-CN'));
    const shownCategories = categories.slice(0,15), categoryMax = Math.max(0,...shownCategories.flatMap(category => category.stores.map(total => metricValue(total,metric) || 0)));
    $('category-chart').innerHTML = shownCategories.map(category => '<div class="category-chart-item"><div class="category-chart-label">' + esc(category.major + ' / ' + category.minor) + '<small>' + number(category.products) + ' 条商品记录</small></div><div class="category-chart-bars">' + category.stores.map(total => {
      const value = metricValue(total,metric), width = categoryMax > 0 && value !== null ? value/categoryMax*100 : 0;
      return '<div class="category-bar-line" title="' + esc(total.name + '：' + metricText(value,metric,total.lower_bound)) + '"><div class="bar-track" role="img" aria-label="' + esc(total.name + ' ' + metricName + ' ' + metricText(value,metric,total.lower_bound)) + '"><div class="bar-fill" style="width:' + width.toFixed(2) + '%;background:' + storeColor(total.id) + '"></div></div><span class="category-bar-value">' + esc(metricText(value,metric,total.lower_bound)) + '</span></div>';
    }).join('') + '</div></div>').join('') + '<p class="category-subtitle">按所选指标汇总排序，展示前 ' + shownCategories.length + ' 个大小类目。可用左侧类目进一步查看。</p>';
    renderRanking(products, selectedStores, metric);
  }
  function renderRanking(products, selectedStores, metric) {
    const selected = new Set(selectedStores.map(store => text(store.id)));
    const ranking = [];
    for (const product of products) for (const offer of product.offers || []) {
      if (!selected.has(text(offer.store_id))) continue;
      const value = metric === 'amount' ? offerAmount(offer) : salesValue(offer.sales) ? offer.sales : null;
      if (value !== null) ranking.push({product,offer,value});
    }
    ranking.sort((a,b) => b.value-a.value || compareOrder(a.product.order,b.product.order));
    $('ranking-title').textContent = '商品' + (metric === 'amount' ? '估算销售额' : '月销量') + '排名';
    $('ranking-head').innerHTML = '<tr><th>#</th><th>商品与规格</th><th>门店</th><th>单品售价</th><th>月销量</th><th>估算销售额</th></tr>';
    $('ranking-body').innerHTML = ranking.slice(0,20).map((item,index) => {
      const product = item.product, offer = item.offer, isFx = product.offers.some(entry => text(entry.store_id) === fxStoreId), groupId = isFx ? 'fx:' + (product.spu || product.id) : 'pending:' + product.id;
      return '<tr><td class="rank' + (index<3 ? ' top' : '') + '">' + String(index+1).padStart(2,'0') + '</td><td><div class="ranking-product">' + imageHtml(product) + '<div><button type="button" class="product-title" data-detail="' + esc(groupId) + '">' + esc(product.name || '名称未提供') + '</button><small>' + esc(product.spec || '规格未提供') + ' · ' + esc(product.major || '未分类') + ' / ' + esc(product.minor || '待分类') + '</small></div></div></td><td class="ranking-number">' + esc(storeName(offer.store_id)) + '</td><td class="ranking-number">' + (offerPrice(offer) !== null ? '¥'+formatMoney(offerPrice(offer)) : '未知') + '</td><td class="ranking-number">' + (salesValue(offer.sales) ? (offer.sales_is_lower_bound ? '≥ ' : '') + number(offer.sales) : '未知') + '</td><td class="ranking-number amount">' + esc(metricText(offerAmount(offer),'amount',offer.sales_is_lower_bound)) + '</td></tr>';
    }).join('') || '<tr><td colspan="6"><p class="store-zero">当前范围没有已知的' + (metric === 'amount' ? '估算销售额' : '月销量') + '，无法排名。</p></td></tr>';
  }
  function renderPage() {
    state.page = location.hash === '#analysis' ? 'analysis' : 'products';
    const analysis = state.page === 'analysis';
    $('products-page').hidden = analysis;
    $('analysis-page').hidden = !analysis;
    document.querySelectorAll('[data-nav]').forEach(link => { link.classList.toggle('active',link.dataset.nav === state.page); if (link.dataset.nav === state.page) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current'); });
    $('breadcrumb').textContent = analysis ? '维度分析' : '商品库';
    $('page-title').textContent = analysis ? '门店销售与品类对比' : '飞象主商品库';
    $('page-description').textContent = analysis ? '从大小类目到具体商品，查看各店已收录数据的销量与估算销售额。' : '以飞象商品为主，按 SPU 整理规格，在同一行对比各店数据。';
    renderCategoryTree();
    if (analysis) renderAnalysis(); else renderCatalog();
    closeSidebar();
  }
  function resetFilters() {
    Object.assign(state, {major:'',minor:'',query:'',storeId:'',match:'',sales:'',sort:'default',currentPage:1});
    $('search').value = ''; $('store-filter').value = ''; $('match-filter').value = ''; $('sales-filter').value = ''; $('sort-filter').value = 'default';
    renderCategoryTree(); renderCatalog();
  }
  function switchLibrary(library) {
    state.library = library; state.match = ''; state.currentPage = 1;
    updateMatchOptions(); renderCategoryTree(); renderCatalog();
  }
  function clearCategory() {
    state.major = ''; state.minor = ''; state.currentPage = 1; renderCategoryTree();
    if (state.page === 'analysis') renderAnalysis(); else renderCatalog();
  }
  function closeSidebar() {
    $('sidebar').classList.remove('open'); $('sidebar-shade').hidden = true;
    $('menu-button').setAttribute('aria-expanded','false');
  }
  function openDetail(id) {
    const group = groupMap.get(id);
    if (!group) return;
    const product = group.product;
    $('detail-title').textContent = product.name || '商品详情';
    $('detail-body').innerHTML = '<div class="detail-product">' + imageHtml(product) + '<div class="detail-meta"><div><b>商品类目</b> ' + esc(product.major || '未分类') + ' / ' + esc(product.minor || '待分类') + '</div><div><b>SPU</b> ' + esc(group.spu || product.spu || '未提供') + '</div><div><b>条码</b> ' + esc(product.barcode || '未提供') + '</div><div><b>规格数</b> ' + number(group.variants.length) + '</div><div class="badges">' + (group.multi_spec ? '<span class="badge multi">▦ 多规格</span>' : '') + '</div></div></div>' + group.variants.map((variant,index) => '<section class="detail-variant"><div class="detail-variant-head"><b>' + (group.variants.length>1 ? String(index+1)+'. ' : '') + esc(variant.spec || '规格未提供') + '</b><small>条码 ' + esc(variant.barcode || '未提供') + '</small></div><div class="detail-variant-offers">' + stores.map(store => {
      const offers = variant.offers.filter(offer => text(offer.store_id) === text(store.id));
      return '<div class="detail-offer"><h3><i class="store-color" style="background:' + storeColor(store.id) + '"></i> ' + esc(store.name) + '</h3>' + (offers.length ? offers.map(offer => offerHtml(offer,true)).join('') : '<span class="not-present">未收录已确认同款</span>') + '</div>';
    }).join('') + '</div></section>').join('') + (matchState(group)==='candidate' ? '<p class="detail-status">该商品有匹配候选，但尚未确认。公开展示不会把候选的价格、销量合并到同一商品；请在本地商品库审核匹配。</p>' : '') + '<p class="detail-readonly">单品优惠优先级：神价 ＞ 超值单品 ＞ 折扣。店铺券“到手价”不作为单品优惠价。未知数值保留为空缺，不自动补 0。</p>';
    $('detail-dialog').showModal();
  }
  function bindEvents() {
    $('catalog-filters').addEventListener('submit',event => event.preventDefault());
    let searchTimer;
    $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.query=$('search').value; state.currentPage=1; renderCatalog(); },160); });
    for (const [id,key] of [['store-filter','storeId'],['match-filter','match'],['sales-filter','sales'],['sort-filter','sort']]) $(id).addEventListener('change',()=>{state[key]=$(id).value;state.currentPage=1;renderCatalog();});
    for (const [id,key] of [['analysis-scope','analysisScope'],['analysis-metric','analysisMetric']]) $(id).addEventListener('change',()=>{state[key]=$(id).value;renderAnalysis();});
    $('analysis-stores').addEventListener('change',()=>{state.analysisStores=[...$('analysis-stores').querySelectorAll('input:checked')].map(input=>input.value);renderAnalysis();});
    $('clear-category').addEventListener('click',clearCategory);
    $('reset-filters').addEventListener('click',resetFilters);
    $('sidebar-shade').addEventListener('click',closeSidebar);
    $('menu-button').addEventListener('click',()=>{const open=!$('sidebar').classList.contains('open');$('sidebar').classList.toggle('open',open);$('sidebar-shade').hidden=!open;$('menu-button').setAttribute('aria-expanded',String(open));});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closeSidebar();});
    document.addEventListener('click',event=>{
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.library) switchLibrary(button.dataset.library);
      if (button.hasAttribute('data-major') && button.hasAttribute('data-minor')) { event.preventDefault(); state.major=button.dataset.major;state.minor=button.dataset.minor;state.currentPage=1;renderCategoryTree();if(state.page==='analysis')renderAnalysis();else renderCatalog();closeSidebar(); }
      if (button.dataset.detail) openDetail(button.dataset.detail);
      if (button.dataset.image && safeImage(button.dataset.image)) { $('image-title').textContent=button.dataset.imageName||'商品图片';$('image-body').innerHTML='<img src="'+esc(button.dataset.image)+'" alt="'+esc(button.dataset.imageName||'商品图片')+'">';$('image-dialog').showModal(); }
      if (button.dataset.close) $(button.dataset.close).close();
      if (button.dataset.page) { state.currentPage=Number(button.dataset.page);renderCatalog();$('catalog-filters').scrollIntoView({block:'start',behavior:'auto'}); }
      if (button.id==='empty-reset') resetFilters();
      if (button.hasAttribute('data-switch-pending')) switchLibrary('pending');
      if (button.hasAttribute('data-analysis-all')) { state.analysisScope='all';$('analysis-scope').value='all';renderAnalysis(); }
      if (button.hasAttribute('data-clear-category')) clearCategory();
    });
    document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();}}));
    document.addEventListener('error',event=>{const img=event.target;if(img.tagName!=='IMG')return;const placeholder=document.createElement('span');placeholder.className='image-placeholder';placeholder.textContent='图片不可用';placeholder.setAttribute('role','img');placeholder.setAttribute('aria-label','图片无法载入');img.replaceWith(placeholder);},true);
    window.addEventListener('hashchange',()=>{if(catalog)renderPage();});
  }
  async function start() {
    bindEvents();
    try {
      const response = await fetch('data/catalog.json', {credentials:'omit'});
      if (!response.ok) throw new Error('商品数据请求失败（HTTP ' + response.status + '）');
      catalog = await response.json();
      if (catalog.schema_version !== 1 || !Array.isArray(catalog.products) || !Array.isArray(catalog.stores)) throw new Error('商品数据格式不受支持，请联系维护者重新发布。');
      stores = catalog.stores.map(store=>({...store,id:text(store.id)}));
      fxStoreId = text((stores.find(store=>/飞象/.test(store.name)) || stores[0] || {}).id);
      stores.sort((a,b)=>(a.id===fxStoreId ? -1 : 0)-(b.id===fxStoreId ? -1 : 0));
      catalog.products.forEach(product=>{product.offers=Array.isArray(product.offers)?product.offers:[];product._search=productSearchText(product);});
      groups = createGroups(catalog.products,fxStoreId);groupMap=new Map(groups.map(group=>[group.id,group]));
      state.analysisStores=stores.map(store=>store.id);
      $('snapshot-date').textContent=dateText(catalog.snapshot_at);$('snapshot-date').setAttribute('datetime',text(catalog.snapshot_at));
      $('store-filter').innerHTML='<option value="">全部门店</option>'+stores.map(store=>'<option value="'+esc(store.id)+'">'+esc(store.name)+'</option>').join('');
      $('analysis-stores').innerHTML=stores.map(store=>'<label><input type="checkbox" value="'+esc(store.id)+'" checked><span class="store-color" style="background:'+storeColor(store.id)+'"></span>'+esc(store.name)+'</label>').join('');
      $('footer-counts').textContent=number(catalog.products.length)+' 条商品记录 · '+stores.length+' 家门店 · 非实时数据';
      renderCatalogSummary();updateMatchOptions();$('load-state').hidden=true;$('content').hidden=false;renderPage();
    } catch(error) {
      $('load-state').innerHTML='<span aria-hidden="true" style="font-size:32px;color:#8cae9f">◈</span><h1>暂时无法载入商品数据</h1><p>'+esc(error.message)+'。请稍后刷新；若通过本地文件直接打开，请改用网页服务器访问。</p><button type="button" class="secondary" id="reload-data">重新载入</button>';
      $('reload-data').addEventListener('click',()=>location.reload());
    }
  }
  start();
})();
