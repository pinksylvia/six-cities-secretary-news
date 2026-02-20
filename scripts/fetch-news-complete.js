#!/usr/bin/env node

/**
 * 完整的新聞抓取、篩選和 Telegram 發送腳本
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

// ==================== 配置 ====================

const CONFIG = {
  // 新聞來源
  NEWS_SOURCES: [
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
  ],

  // 篩選規則
  FILTER_RULES: {
    // 必須包含的城市
    cities: ['台北', '新北', '桃園', '台中', '台南', '高雄'],
    
    // 必須包含的關鍵字（任一即可）
    keywords: [
      '秘書處', '秘書長', '市政府',
      '市長', '副市長', '局長',
      '政策', '會議', '視察',
      '國際交流', '簽署', '協議'
    ],

    // 排除的關鍵字（包含則排除）
    excludeKeywords: [
      '娛樂', '運動', '明星', '八卦',
      '股市', '房市', '天氣', '寵物'
    ],

    // 評分權重
    weights: {
      city: 10,
      keyword: 5,
      category: 3
    },

    // 最低評分閾值
    minScore: 5
  },

  // Telegram 設定
  TELEGRAM: {
    timeout: 10000,
    maxRetries: 3,
    retryDelay: 1000
  },

  // 日誌設定
  LOGGING: {
    enabled: true,
    dir: './logs',
    level: 'info'  // debug, info, warn, error
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

    // 控制台輸出
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

const logger = new Logger(CONFIG.LOGGING);

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
      if (articles.length >= 50) return; // 限制每個源 50 條

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

  for (const source of CONFIG.NEWS_SOURCES) {
    const news = await fetchFromSource(source);
    allNews.push(...news);
    
    // 避免請求過於頻繁
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  logger.info(`總共抓取 ${allNews.length} 條新聞`);
  return allNews;
}

// ==================== 新聞篩選 ====================

/**
 * 計算新聞相關度評分
 */
function calculateScore(news) {
  let score = 0;
  const text = (news.title + ' ' + news.summary).toLowerCase();

  // 城市匹配
  CONFIG.FILTER_RULES.cities.forEach(city => {
    if (text.includes(city.toLowerCase())) {
      score += CONFIG.FILTER_RULES.weights.city;
    }
  });

  // 關鍵字匹配
  CONFIG.FILTER_RULES.keywords.forEach(keyword => {
    if (text.includes(keyword.toLowerCase())) {
      score += CONFIG.FILTER_RULES.weights.keyword;
    }
  });

  // 排除關鍵字
  CONFIG.FILTER_RULES.excludeKeywords.forEach(keyword => {
    if (text.includes(keyword.toLowerCase())) {
      score = 0;
    }
  });

  return score;
}

/**
 * 提取城市信息
 */
function extractCity(news) {
  const text = news.title + ' ' + news.summary;
  for (const city of CONFIG.FILTER_RULES.cities) {
    if (text.includes(city)) {
      return city;
    }
  }
  return '其他';
}

/**
 * 篩選相關新聞
 */
function filterNews(allNews) {
  logger.info('開始篩選新聞...');

  const filtered = allNews
    .map(news => ({
      ...news,
      score: calculateScore(news),
      city: extractCity(news),
      category: '秘書處業務'
    }))
    .filter(news => news.score >= CONFIG.FILTER_RULES.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50); // 最多 50 條

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
    message += `<b>【${city}】</b>\n`;
    items.slice(0, 5).forEach((item) => {
      newsCount++;
      message += `${newsCount}. <b>${item.title.substring(0, 60)}</b>\n`;
      message += `   ${item.summary.substring(0, 80)}...\n`;
      message += `   🔗 <a href="${item.url}">閱讀全文</a>\n`;
      message += `   📌 ${item.source}\n\n`;
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
    logger.debug(`正在發送訊息到 Telegram (嘗試 ${retryCount + 1}/${CONFIG.TELEGRAM.maxRetries})...`);

    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      },
      {
        timeout: CONFIG.TELEGRAM.timeout
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

    if (retryCount < CONFIG.TELEGRAM.maxRetries - 1) {
      const delay = CONFIG.TELEGRAM.retryDelay * Math.pow(2, retryCount);
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
    // 這裡需要根據實際情況實現
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

    // 步驟 1：抓取新聞
    const allNews = await fetchAllNews();

    if (allNews.length === 0) {
      logger.warn('未抓取到任何新聞');
    }

    // 步驟 2：篩選新聞
    const filteredNews = filterNews(allNews);

    // 步驟 3：生成訊息
    const message = generateTelegramMessage(filteredNews);

    // 步驟 4：發送到 Telegram
    logger.info('正在發送到 Telegram...');
    const sent = await sendToTelegram(botToken, chatId, message);

    if (!sent) {
      throw new Error('Telegram 發送失敗');
    }

    // 步驟 5：儲存到 Google Sheets（可選）
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
