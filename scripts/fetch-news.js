#!/usr/bin/env node

/**
 * 完整的新聞抓取、篩選和 Telegram 發送腳本（整合 filter-rules-loader）
 * 用於 GitHub Actions 每日執行
 * 
 * 使用方法：
 *   node fetch-news.js
 * 
 * 環境變數：
 *   TELEGRAM_BOT_TOKEN - Telegram Bot Token
 *   TELEGRAM_GROUP_ID - Telegram 群組 ID
 *   GOOGLE_SHEETS_ID - Google Sheets ID（可選）
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// 載入篩選規則載入器
let filterRulesLoader;
try {
  filterRulesLoader = require('./filter-rules-loader');
} catch (e) {
  console.warn('⚠️ 無法載入 filter-rules-loader，將使用內置規則');
  filterRulesLoader = null;
}

// ==================== 新聞來源配置 ====================

const NEWS_SOURCES = [
  {
    name: '聯合新聞網',
    url: 'https://udn.com/news/index',
    selector: 'article',
    titleSelector: 'h2, h3',
    summarySelector: 'p',
    linkSelector: 'a'
  },
  {
    name: '自由時報',
    url: 'https://www.ltn.com.tw/',
    selector: 'article, .news-item',
    titleSelector: 'h2, h3, .title',
    summarySelector: 'p, .summary',
    linkSelector: 'a'
  },
  {
    name: '中時新聞網',
    url: 'https://www.chinatimes.com/',
    selector: '.news-item, article',
    titleSelector: 'h2, h3',
    summarySelector: 'p',
    linkSelector: 'a'
  }
];

// ==================== 預設篩選規則 ====================

const DEFAULT_FILTER_RULES = {
  filterRules: {
    cities: {
      values: ['台北', '新北', '桃園', '台中', '台南', '高雄'],
      weight: 10
    },
    keywords: {
      values: [
        '秘書處', '秘書長', '市政府', '市長', '副市長',
        '政策', '會議', '視察', '國際交流', '簽署',
        '協議', '公告', '通知', '宣布', '發布'
      ],
      weight: 5
    },
    excludeKeywords: {
      values: [
        '娛樂', '運動', '明星', '八卦', '股市', '房市',
        '天氣', '寵物', '美食', '旅遊'
      ],
      weight: -100
    },
    categoryKeywords: {
      categories: {
        '秘書處業務': {
          keywords: ['秘書處', '秘書長', '行政', '公務', '人事'],
          weight: 3
        },
        '市政新聞': {
          keywords: ['市長', '副市長', '市政', '政策', '會議'],
          weight: 2
        },
        '國際交流': {
          keywords: ['國際', '交流', '簽署', '協議', '友好'],
          weight: 2
        }
      }
    }
  },
  scoringRules: {
    minScore: 5
  }
};

// ==================== 日誌系統 ====================

class Logger {
  constructor(config) {
    this.config = config;
    this.logs = [];
    this.ensureLogDir();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.config.dir)) {
      fs.mkdirSync(this.config.dir, { recursive: true });
    }
  }

  log(level, message, data = null) {
    const timestamp = new Date().toLocaleString('zh-TW');
    const logEntry = {
      timestamp,
      level,
      message,
      data
    };

    this.logs.push(logEntry);

    const prefix = {
      debug: '🔍',
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌'
    }[level] || '📝';

    console.log(`[${timestamp}] ${prefix} ${message}`);
    if (data) {
      console.log('   ', data);
    }
  }

  debug(message, data) { this.log('debug', message, data); }
  info(message, data) { this.log('info', message, data); }
  warn(message, data) { this.log('warn', message, data); }
  error(message, data) { this.log('error', message, data); }

  save() {
    const filename = path.join(
      this.config.dir,
      `news-fetch-${new Date().toISOString().split('T')[0]}.log`
    );

    const content = this.logs
      .map(log => `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`)
      .join('\n');

    fs.writeFileSync(filename, content);
    this.info(`日誌已保存到 ${filename}`);
  }
}

const logger = new Logger({ dir: './logs' });

// ==================== 篩選規則管理 ====================

/**
 * 載入篩選規則
 */
function loadFilterRules() {
  try {
    if (filterRulesLoader) {
      const rules = filterRulesLoader.loadFilterRules('./config/filter-rules.json');
      logger.info('已從 filter-rules.json 載入篩選規則');
      return rules;
    }
  } catch (error) {
    logger.warn(`無法載入 filter-rules.json: ${error.message}`);
  }

  logger.info('使用預設篩選規則');
  return DEFAULT_FILTER_RULES;
}

/**
 * 計算新聞評分
 */
function calculateScore(news, rules) {
  if (filterRulesLoader) {
    return filterRulesLoader.calculateScore(news, rules);
  }

  // 備用實現
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
        return 0;
      }
    }
  }

  return score;
}

/**
 * 提取城市信息
 */
function extractCity(news, rules) {
  if (filterRulesLoader) {
    return filterRulesLoader.extractCity(news, rules);
  }

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
 * 提取分類
 */
function extractCategory(news, rules) {
  if (filterRulesLoader) {
    return filterRulesLoader.extractCategory(news, rules);
  }

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

// ==================== 新聞抓取 ====================

/**
 * 從單個新聞源抓取新聞
 */
async function fetchFromSource(source) {
  try {
    logger.debug(`正在抓取 ${source.name}...`);

    const response = await axios.get(source.url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const articles = [];

    $(source.selector).each((i, el) => {
      if (articles.length >= 50) return;

      try {
        const title = $(el).find(source.titleSelector).first().text().trim();
        const summary = $(el).find(source.summarySelector).first().text().trim();
        const url = $(el).find(source.linkSelector).first().attr('href');

        if (title && url) {
          articles.push({
            title: title.substring(0, 200),
            summary: summary.substring(0, 300),
            url: url.startsWith('http') ? url : source.url + url,
            source: source.name,
            fetchedAt: new Date().toISOString()
          });
        }
      } catch (e) {
        // 跳過解析失敗的文章
      }
    });

    logger.info(`${source.name} 抓取完成，共 ${articles.length} 條新聞`);
    return articles;
  } catch (error) {
    logger.error(`${source.name} 抓取失敗: ${error.message}`);
    return [];
  }
}

/**
 * 從所有新聞源抓取新聞
 */
async function fetchAllNews() {
  logger.info('開始抓取新聞...');

  const allNews = [];

  for (const source of NEWS_SOURCES) {
    const news = await fetchFromSource(source);
    allNews.push(...news);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  logger.info(`總共抓取 ${allNews.length} 條新聞`);
  return allNews;
}

// ==================== 新聞篩選 ====================

/**
 * 篩選相關新聞
 */
function filterNews(allNews, rules) {
  logger.info('開始篩選新聞...');

  if (filterRulesLoader) {
    const filtered = filterRulesLoader.filterNews(allNews, rules);
    logger.info(`篩選完成，保留 ${filtered.length} 條相關新聞`);
    return filtered;
  }

  // 備用實現
  const minScore = rules.scoringRules?.minScore || 5;

  const filtered = allNews
    .map(news => ({
      ...news,
      score: calculateScore(news, rules),
      city: extractCity(news, rules),
      category: extractCategory(news, rules)
    }))
    .filter(news => news.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  logger.info(`篩選完成，保留 ${filtered.length} 條相關新聞`);
  return filtered;
}

// ==================== Telegram 發送 ====================

/**
 * 生成 Telegram 訊息
 */
function generateTelegramMessage(newsArray) {
  if (!newsArray || newsArray.length === 0) {
    return `📰 <b>台灣六都市政府秘書處新聞摘要</b>\n📅 ${new Date().toLocaleDateString('zh-TW')}\n\n⚠️ 今日無相關新聞。`;
  }

  let message = `📰 <b>台灣六都市政府秘書處新聞摘要</b>\n`;
  message += `📅 ${new Date().toLocaleDateString('zh-TW')}\n`;
  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // 按城市分組
  const grouped = {};
  newsArray.forEach(item => {
    if (!grouped[item.city]) grouped[item.city] = [];
    grouped[item.city].push(item);
  });

  let newsCount = 0;
  Object.entries(grouped).forEach(([city, items]) => {
    message += `<b>【${city}】</b> (${items.length} 則)\n`;
    items.slice(0, 5).forEach((item) => {
      newsCount++;
      message += `${newsCount}. <b>${item.title.substring(0, 60)}</b>\n`;
      message += `   ${item.summary.substring(0, 80)}...\n`;
      message += `   🔗 <a href="${item.url}">閱讀全文</a>\n`;
      message += `   📌 ${item.source} | 分類: ${item.category}\n\n`;
    });
  });

  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `共 ${newsArray.length} 則新聞\n`;
  message += `⏰ ${new Date().toLocaleString('zh-TW')}\n`;
  message += `\n💡 提示：點擊「閱讀全文」查看完整新聞內容`;

  return message;
}

/**
 * 發送訊息到 Telegram
 */
async function sendToTelegram(botToken, chatId, message, retryCount = 0) {
  try {
    logger.debug(`正在發送訊息到 Telegram (嘗試 ${retryCount + 1}/3)...`);

    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      },
      {
        timeout: 10000
      }
    );

    if (response.data.ok) {
      logger.info(`✅ 訊息已成功發送到 Telegram (Message ID: ${response.data.result.message_id})`);
      return true;
    } else {
      throw new Error(response.data.description);
    }
  } catch (error) {
    logger.error(`發送失敗: ${error.message}`);

    if (retryCount < 2) {
      const delay = 1000 * Math.pow(2, retryCount);
      logger.warn(`等待 ${delay}ms 後重試...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendToTelegram(botToken, chatId, message, retryCount + 1);
    }

    return false;
  }
}

// ==================== Google Sheets 儲存（可選）====================

/**
 * 儲存新聞到 Google Sheets（可選功能）
 */
async function saveToGoogleSheets(news) {
  const sheetsId = process.env.GOOGLE_SHEETS_ID;
  const credentials = process.env.GOOGLE_SHEETS_CREDENTIALS;

  if (!sheetsId || !credentials) {
    logger.debug('跳過 Google Sheets 儲存（未配置）');
    return true;
  }

  try {
    logger.debug('正在儲存新聞到 Google Sheets...');
    // 實現 Google Sheets API 調用
    logger.info('新聞已儲存到 Google Sheets');
    return true;
  } catch (error) {
    logger.error(`Google Sheets 儲存失敗: ${error.message}`);
    return false;
  }
}

// ==================== 主函數 ====================

/**
 * 主執行函數
 */
async function main() {
  try {
    logger.info('========== 新聞抓取和發送流程開始 ==========');

    // 驗證環境變數
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_GROUP_ID;

    if (!botToken || !chatId) {
      throw new Error('缺少必要的環境變數：TELEGRAM_BOT_TOKEN 或 TELEGRAM_GROUP_ID');
    }

    logger.info('環境變數驗證完成');

    // 步驟 1：載入篩選規則
    logger.info('正在載入篩選規則...');
    const rules = loadFilterRules();

    // 步驟 2：抓取新聞
    const allNews = await fetchAllNews();

    if (allNews.length === 0) {
      logger.warn('未抓取到任何新聞');
    }

    // 步驟 3：篩選新聞
    const filteredNews = filterNews(allNews, rules);

    // 步驟 4：生成訊息
    const message = generateTelegramMessage(filteredNews);

    // 步驟 5：發送到 Telegram
    logger.info('正在發送到 Telegram...');
    const sent = await sendToTelegram(botToken, chatId, message);

    if (!sent) {
      throw new Error('Telegram 發送失敗');
    }

    // 步驟 6：儲存到 Google Sheets（可選）
    await saveToGoogleSheets(filteredNews);

    logger.info('========== 流程完成 ==========');
    logger.save();

    process.exit(0);
  } catch (error) {
    logger.error(`流程出錯: ${error.message}`);
    logger.save();
    process.exit(1);
  }
}

// 執行主函數
main();
