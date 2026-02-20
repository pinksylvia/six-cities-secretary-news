/**
 * 篩選規則載入和管理工具
 * 用於讀取和使用 filter-rules.json 配置檔案
 */

const fs = require('fs');
const path = require('path');

/**
 * 載入篩選規則配置
 * @param {string} configPath - 配置檔案路徑
 * @returns {Object} 篩選規則配置物件
 */
function loadFilterRules(configPath = './config/filter-rules.json') {
  try {
    // 嘗試多個可能的路徑
    const possiblePaths = [
      configPath,
      path.join(__dirname, configPath),
      path.join(__dirname, 'config', 'filter-rules.json'),
      path.join(process.cwd(), 'config', 'filter-rules.json')
    ];

    let filePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        filePath = p;
        break;
      }
    }

    if (!filePath) {
      console.warn('⚠️ filter-rules.json 未找到，使用預設規則');
      return getDefaultRules();
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content);

    console.log(`✅ 已載入篩選規則配置：${filePath}`);
    return config;
  } catch (error) {
    console.error(`❌ 載入篩選規則失敗：${error.message}`);
    return getDefaultRules();
  }
}

/**
 * 取得預設篩選規則
 * @returns {Object} 預設規則配置
 */
function getDefaultRules() {
  return {
    filterRules: {
      cities: {
        values: ['台北', '新北', '桃園', '台中', '台南', '高雄'],
        weight: 10
      },
      keywords: {
        values: [
          '秘書處', '秘書長', '市政府', '市長', '副市長',
          '政策', '會議', '視察', '國際交流', '簽署'
        ],
        weight: 5
      },
      excludeKeywords: {
        values: ['娛樂', '運動', '明星', '八卦', '股市', '房市'],
        weight: -100
      }
    },
    scoringRules: {
      minScore: 5
    }
  };
}

/**
 * 計算新聞評分
 * @param {Object} news - 新聞物件 {title, summary}
 * @param {Object} rules - 篩選規則配置
 * @returns {number} 評分
 */
function calculateScore(news, rules) {
  let score = 0;
  const text = (news.title + ' ' + news.summary).toLowerCase();

  const filterRules = rules.filterRules || {};

  // 城市匹配
  if (filterRules.cities && filterRules.cities.values) {
    filterRules.cities.values.forEach(city => {
      if (text.includes(city.toLowerCase())) {
        score += filterRules.cities.weight || 10;
      }
    });
  }

  // 關鍵字匹配
  if (filterRules.keywords && filterRules.keywords.values) {
    filterRules.keywords.values.forEach(keyword => {
      if (text.includes(keyword.toLowerCase())) {
        score += filterRules.keywords.weight || 5;
      }
    });
  }

  // 排除關鍵字
  if (filterRules.excludeKeywords && filterRules.excludeKeywords.values) {
    for (const keyword of filterRules.excludeKeywords.values) {
      if (text.includes(keyword.toLowerCase())) {
        return 0; // 包含排除詞則完全排除
      }
    }
  }

  return score;
}

/**
 * 提取新聞分類
 * @param {Object} news - 新聞物件
 * @param {Object} rules - 篩選規則配置
 * @returns {string} 分類標籤
 */
function extractCategory(news, rules) {
  const text = (news.title + ' ' + news.summary).toLowerCase();
  const categoryKeywords = rules.filterRules?.categoryKeywords?.categories || {};

  for (const [category, config] of Object.entries(categoryKeywords)) {
    if (config.keywords) {
      for (const keyword of config.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          return category;
        }
      }
    }
  }

  return '其他';
}

/**
 * 提取城市信息
 * @param {Object} news - 新聞物件
 * @param {Object} rules - 篩選規則配置
 * @returns {string} 城市名稱
 */
function extractCity(news, rules) {
  const text = news.title + ' ' + news.summary;
  const cities = rules.filterRules?.cities?.values || [];

  for (const city of cities) {
    if (text.includes(city)) {
      return city;
    }
  }

  return '其他';
}

/**
 * 篩選新聞
 * @param {Array} allNews - 所有新聞陣列
 * @param {Object} rules - 篩選規則配置
 * @returns {Array} 篩選後的新聞陣列
 */
function filterNews(allNews, rules) {
  const minScore = rules.scoringRules?.minScore || 5;

  return allNews
    .map(news => ({
      ...news,
      score: calculateScore(news, rules),
      city: extractCity(news, rules),
      category: extractCategory(news, rules)
    }))
    .filter(news => news.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50); // 最多 50 條
}

/**
 * 驗證篩選規則配置
 * @param {Object} rules - 篩選規則配置
 * @returns {Object} 驗證結果 {valid: boolean, errors: Array}
 */
function validateRules(rules) {
  const errors = [];

  // 檢查必要欄位
  if (!rules.filterRules) {
    errors.push('缺少 filterRules 欄位');
  }

  if (!rules.scoringRules) {
    errors.push('缺少 scoringRules 欄位');
  }

  // 檢查城市配置
  if (!rules.filterRules?.cities?.values || rules.filterRules.cities.values.length === 0) {
    errors.push('cities 陣列為空');
  }

  // 檢查關鍵字配置
  if (!rules.filterRules?.keywords?.values || rules.filterRules.keywords.values.length === 0) {
    errors.push('keywords 陣列為空');
  }

  // 檢查評分配置
  if (typeof rules.scoringRules.minScore !== 'number') {
    errors.push('minScore 必須是數字');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 列出所有篩選規則
 * @param {Object} rules - 篩選規則配置
 */
function printRules(rules) {
  console.log('\n========== 篩選規則配置 ==========\n');

  // 城市
  console.log('【城市】(權重: ' + (rules.filterRules?.cities?.weight || 10) + ')');
  console.log(rules.filterRules?.cities?.values?.join(', '));

  // 關鍵字
  console.log('\n【關鍵字】(權重: ' + (rules.filterRules?.keywords?.weight || 5) + ')');
  console.log(rules.filterRules?.keywords?.values?.join(', '));

  // 排除詞
  console.log('\n【排除詞】');
  console.log(rules.filterRules?.excludeKeywords?.values?.join(', '));

  // 評分規則
  console.log('\n【評分規則】');
  console.log('最低評分: ' + (rules.scoringRules?.minScore || 5));

  // 分類
  if (rules.filterRules?.categoryKeywords?.categories) {
    console.log('\n【分類關鍵字】');
    Object.entries(rules.filterRules.categoryKeywords.categories).forEach(([category, config]) => {
      console.log(`  ${category}: ${config.keywords?.join(', ')}`);
    });
  }

  console.log('\n================================\n');
}

/**
 * 測試篩選規則
 * @param {Array} testNews - 測試新聞陣列
 * @param {Object} rules - 篩選規則配置
 */
function testRules(testNews, rules) {
  console.log('\n========== 篩選規則測試 ==========\n');

  testNews.forEach((news, index) => {
    const score = calculateScore(news, rules);
    const city = extractCity(news, rules);
    const category = extractCategory(news, rules);
    const passed = score >= (rules.scoringRules?.minScore || 5);

    console.log(`${index + 1}. ${news.title}`);
    console.log(`   城市: ${city}`);
    console.log(`   分類: ${category}`);
    console.log(`   評分: ${score} ${passed ? '✅ 通過' : '❌ 不通過'}`);
    console.log();
  });
}

/**
 * 更新篩選規則
 * @param {Object} newRules - 新的篩選規則
 * @param {string} filePath - 檔案路徑
 */
function updateRules(newRules, filePath = './config/filter-rules.json') {
  try {
    // 驗證新規則
    const validation = validateRules(newRules);
    if (!validation.valid) {
      console.error('❌ 規則驗證失敗：');
      validation.errors.forEach(error => console.error(`   - ${error}`));
      return false;
    }

    // 確保目錄存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 寫入檔案
    fs.writeFileSync(filePath, JSON.stringify(newRules, null, 2));
    console.log(`✅ 篩選規則已更新：${filePath}`);
    return true;
  } catch (error) {
    console.error(`❌ 更新篩選規則失敗：${error.message}`);
    return false;
  }
}

/**
 * 新增城市
 * @param {Object} rules - 篩選規則配置
 * @param {string} city - 城市名稱
 */
function addCity(rules, city) {
  if (!rules.filterRules.cities.values.includes(city)) {
    rules.filterRules.cities.values.push(city);
    console.log(`✅ 已新增城市：${city}`);
  } else {
    console.log(`⚠️ 城市已存在：${city}`);
  }
}

/**
 * 新增關鍵字
 * @param {Object} rules - 篩選規則配置
 * @param {string} keyword - 關鍵字
 */
function addKeyword(rules, keyword) {
  if (!rules.filterRules.keywords.values.includes(keyword)) {
    rules.filterRules.keywords.values.push(keyword);
    console.log(`✅ 已新增關鍵字：${keyword}`);
  } else {
    console.log(`⚠️ 關鍵字已存在：${keyword}`);
  }
}

/**
 * 新增排除詞
 * @param {Object} rules - 篩選規則配置
 * @param {string} keyword - 排除詞
 */
function addExcludeKeyword(rules, keyword) {
  if (!rules.filterRules.excludeKeywords.values.includes(keyword)) {
    rules.filterRules.excludeKeywords.values.push(keyword);
    console.log(`✅ 已新增排除詞：${keyword}`);
  } else {
    console.log(`⚠️ 排除詞已存在：${keyword}`);
  }
}

// 導出函數
module.exports = {
  loadFilterRules,
  getDefaultRules,
  calculateScore,
  extractCategory,
  extractCity,
  filterNews,
  validateRules,
  printRules,
  testRules,
  updateRules,
  addCity,
  addKeyword,
  addExcludeKeyword
};
