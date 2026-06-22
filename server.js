const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const path = require('path');

// ============ 配置 ============
const MQTT_BROKER = 'mqtt://broker-cn.emqx.io:1883';
const MQTT_TOPIC  = 'pv_monitor/data';
const HTTP_PORT   = process.env.PORT || 3000;
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'pv_data.db');

// ============ 数据库 ============
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('auto_vacuum = incremental');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    voltage   REAL NOT NULL,
    current   REAL NOT NULL,
    power     REAL NOT NULL,
    temp      REAL NOT NULL,
    light     REAL NOT NULL,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch('now')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON sensor_data(timestamp);
  CREATE INDEX IF NOT EXISTS idx_created   ON sensor_data(created_at);
`);

// 每10分钟清理一次旧数据（保留7天）
const DATA_RETENTION_MS = 7 * 24 * 3600 * 1000;
setInterval(() => {
  const cutoff = Date.now() - DATA_RETENTION_MS;
  db.prepare('DELETE FROM sensor_data WHERE timestamp < ?').run(Math.floor(cutoff / 1000));
  db.pragma('incremental_vacuum');
}, 10 * 60 * 1000);

// ============ MQTT 客户端 ============
const mqttClient = mqtt.connect(MQTT_BROKER, {
  clientId: 'cloud_server_' + Math.random().toString(16).slice(2, 8),
  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 10000,
});

const insertData = db.prepare(
  'INSERT INTO sensor_data (voltage, current, power, temp, light, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
);

let lastData = null;

mqttClient.on('connect', () => {
  console.log('[MQTT] 已连接:', MQTT_BROKER);
  mqttClient.subscribe(MQTT_TOPIC, (err) => {
    if (err) console.error('[MQTT] 订阅失败:', err);
    else console.log('[MQTT] 已订阅:', MQTT_TOPIC);
  });
});

mqttClient.on('message', (topic, payload) => {
  try {
    const msg = JSON.parse(payload.toString());
    const now = Math.floor(Date.now() / 1000);
    const data = {
      voltage:  Number(msg.voltage)  || 0,
      current:  Number(msg.current)  || 0,
      power:    Number(msg.power)    || 0,
      temp:     Number(msg.temp)     || 0,
      light:    Number(msg.light)    || 0,
      timestamp: now,
    };
    insertData.run(data.voltage, data.current, data.power, data.temp, data.light, now);
    lastData = data;
    process.stdout.write('.');  // 数据写入指示点
  } catch (e) {
    console.error('[MQTT] 解析失败:', e.message);
  }
});

mqttClient.on('error', (err) => console.error('[MQTT] 连接错误:', err));
mqttClient.on('close', () => console.log('[MQTT] 已断开'));

// ============ Express HTTP 服务 ============
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// 数据提取辅助函数
function extractData(row) {
  return {
    voltage:  row.voltage,
    current:  row.current,
    power:    row.power,
    temp:     row.temp,
    light:    row.light,
    timestamp: row.timestamp * 1000, // 转毫秒
    time:     row.created_at,
  };
}

// ============ API 路由 ============

// 最新一条数据
app.get('/api/data/latest', (req, res) => {
  const row = db.prepare('SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1').get();
  if (!row) return res.json({ ok: true, data: null });
  res.json({ ok: true, data: extractData(row) });
});

// 历史数据：/api/data/history?hours=24&limit=1000
app.get('/api/data/history', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  const cutoff = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);

  let rows;
  if (hours <= 1) {
    // 1小时内返回所有原始数据
    rows = db.prepare(
      'SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id DESC LIMIT ?'
    ).all(cutoff, limit);
  } else {
    // 长时间用采样（每N条取一条）
    const total = db.prepare(
      'SELECT COUNT(*) as cnt FROM sensor_data WHERE timestamp >= ?'
    ).get(cutoff).cnt;
    const step = Math.max(1, Math.floor(total / limit));

    rows = db.prepare(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (ORDER BY id) as rn
        FROM sensor_data WHERE timestamp >= ?
      ) WHERE rn % ? = 0
      ORDER BY id DESC
      LIMIT ?
    `).all(cutoff, step, limit);
  }

  res.json({
    ok: true,
    count: rows.length,
    data: rows.reverse().map(extractData),
  });
});

// 统计数据：/api/data/stats?hours=24
app.get('/api/data/stats', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const cutoff = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as count,
      ROUND(AVG(voltage), 2) as avg_voltage,
      MAX(voltage) as max_voltage,
      MIN(voltage) as min_voltage,
      ROUND(AVG(current), 2) as avg_current,
      MAX(current) as max_current,
      ROUND(AVG(power), 2) as avg_power,
      MAX(power) as max_power,
      ROUND(SUM(power)/60.0, 2) as energy_wh,
      ROUND(AVG(temp), 1) as avg_temp,
      MAX(temp) as max_temp,
      ROUND(AVG(light), 0) as avg_light,
      MAX(light) as max_light
    FROM sensor_data WHERE timestamp >= ?
  `).get(cutoff);

  res.json({ ok: true, stats });
});

// 数据导出 CSV
app.get('/api/data/export', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const cutoff = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);

  const rows = db.prepare(
    'SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id ASC'
  ).all(cutoff);

  let csv = '时间,电压(V),电流(A),功率(W),温度(°C),光照(W/m²)\n';
  for (const r of rows) {
    csv += `${r.created_at},${r.voltage},${r.current},${r.power},${r.temp},${r.light}\n`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=pv_data.csv');
  res.send('﻿' + csv); // BOM for Excel
});

// SSE 实时推送（前端不用 MQTT.js 也能收实时数据）
app.get('/api/data/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 每2秒查询最新数据推送
  const interval = setInterval(() => {
    const row = db.prepare('SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1').get();
    if (row) send(extractData(row));
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// 启动
app.listen(HTTP_PORT, () => {
  console.log(`\n☀️  光伏云平台已启动: http://localhost:${HTTP_PORT}`);
  console.log('   API: /api/data/latest | /api/data/history | /api/data/stats | /api/data/export');
  console.log('   等待 ESP8266 数据...\n');
});
