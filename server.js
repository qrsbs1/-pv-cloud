const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const MQTT_BROKER = 'mqtt://broker-cn.emqx.io:1883';
const MQTT_TOPIC  = 'pv_monitor/data';
const HTTP_PORT   = process.env.PORT || 3000;
const DB_PATH     = process.env.DB_PATH || path.join(__dirname, 'pv_data.db');

// ============ 数据库 ============
let db; // sql.js 实例

function dbRun(sql, params = []) {
  try { db.run(sql, params); } catch (e) { console.error('[DB] run error:', e.message); }
}

function dbGet(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      stmt.free();
      const row = {};
      cols.forEach((c, i) => row[c] = vals[i]);
      return row;
    }
    stmt.free();
    return null;
  } catch (e) { console.error('[DB] get error:', e.message); return null; }
}

function dbAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const vals = stmt.get();
      const row = {};
      cols.forEach((c, i) => row[c] = vals[i]);
      rows.push(row);
    }
    stmt.free();
    return rows;
  } catch (e) { console.error('[DB] all error:', e.message); return []; }
}

function saveDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) { console.error('[DB] save error:', e.message); }
}

async function initDB() {
  const SQL = await initSqlJs();
  try {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log('[DB] 已加载已有数据库');
  } catch {
    db = new SQL.Database();
    console.log('[DB] 已创建新数据库');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      voltage   REAL NOT NULL,
      current   REAL NOT NULL,
      power     REAL NOT NULL,
      temp      REAL NOT NULL,
      light     REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  // 创建索引（sql.js 不支持 IF NOT EXISTS for index，catch 忽略错误）
  try { db.run('CREATE INDEX idx_timestamp ON sensor_data(timestamp)'); } catch(e) {}
  try { db.run('CREATE INDEX idx_created   ON sensor_data(created_at)'); } catch(e) {}
  saveDB();
  console.log('[DB] 数据库初始化完成');
}

// 每30秒自动保存
setInterval(saveDB, 30000);

// 每10分钟清理旧数据（保留7天）
setInterval(() => {
  const cutoff = Math.floor((Date.now() - 7 * 24 * 3600 * 1000) / 1000);
  dbRun('DELETE FROM sensor_data WHERE timestamp < ?', [cutoff]);
  saveDB();
}, 10 * 60 * 1000);

// ============ MQTT 客户端 ============
let mqttClient;

function connectMQTT() {
  mqttClient = mqtt.connect(MQTT_BROKER, {
    clientId: 'cloud_server_' + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
  });

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
      const timeStr = new Date().toISOString().replace('T',' ').slice(0,19);

      dbRun(
        'INSERT INTO sensor_data (voltage, current, power, temp, light, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [Number(msg.voltage)||0, Number(msg.current)||0, Number(msg.power)||0, Number(msg.temp)||0, Number(msg.light)||0, now, timeStr]
      );
      process.stdout.write('.');
    } catch (e) {
      console.error('[MQTT] 解析失败:', e.message);
    }
  });

  mqttClient.on('error', (err) => console.error('[MQTT] 连接错误:', err));
  mqttClient.on('close', () => console.log('[MQTT] 已断开，自动重连...'));
}

// ============ Express HTTP 服务 ============
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

function extractData(row) {
  return {
    voltage:  row.voltage,
    current:  row.current,
    power:    row.power,
    temp:     row.temp,
    light:    row.light,
    timestamp: (typeof row.timestamp === 'number' ? row.timestamp : 0) * 1000,
    time:     row.created_at,
  };
}

// 最新一条
app.get('/api/data/latest', (req, res) => {
  const row = dbGet('SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1');
  if (!row) return res.json({ ok: true, data: null });
  res.json({ ok: true, data: extractData(row) });
});

// 历史数据
app.get('/api/data/history', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const limit = Math.min(parseInt(req.query.limit) || 500, 5000);
  const cutoff = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);

  let rows;
  if (hours <= 1) {
    rows = dbAll(
      'SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id DESC LIMIT ?',
      [cutoff, limit]
    );
  } else {
    // 采样
    const all = dbAll(
      'SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id ASC',
      [cutoff]
    );
    const step = Math.max(1, Math.floor(all.length / limit));
    rows = all.filter((_, i) => i % step === 0).slice(-limit).reverse();
  }

  res.json({
    ok: true,
    count: rows.length,
    data: Array.isArray(rows) ? rows.reverse().map(extractData) : [],
  });
});

// 统计
app.get('/api/data/stats', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const cutoff = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);

  const rows = dbAll(
    'SELECT voltage, current, power, temp, light FROM sensor_data WHERE timestamp >= ?',
    [cutoff]
  );

  if (!rows.length) return res.json({ ok: true, stats: { count: 0 } });

  const cnt = rows.length;
  const sumV = rows.reduce((s,r) => s+r.voltage, 0);
  const sumC = rows.reduce((s,r) => s+r.current, 0);
  const sumP = rows.reduce((s,r) => s+r.power, 0);
  const sumT = rows.reduce((s,r) => s+r.temp, 0);
  const sumL = rows.reduce((s,r) => s+r.light, 0);
  const maxV = Math.max(...rows.map(r=>r.voltage));
  const minV = Math.min(...rows.map(r=>r.voltage));
  const maxC = Math.max(...rows.map(r=>r.current));
  const maxP = Math.max(...rows.map(r=>r.power));
  const maxT = Math.max(...rows.map(r=>r.temp));
  const maxL = Math.max(...rows.map(r=>r.light));

  res.json({
    ok: true,
    stats: {
      count: cnt,
      avg_voltage:  Math.round(sumV/cnt*100)/100,
      max_voltage:  Math.round(maxV*100)/100,
      min_voltage:  Math.round(minV*100)/100,
      avg_current:  Math.round(sumC/cnt*100)/100,
      max_current:  Math.round(maxC*100)/100,
      avg_power:    Math.round(sumP/cnt*100)/100,
      max_power:    Math.round(maxP*100)/100,
      energy_wh:    Math.round(sumP/60*100)/100,
      avg_temp:     Math.round(sumT/cnt*10)/10,
      max_temp:     Math.round(maxT*10)/10,
      avg_light:    Math.round(sumL/cnt),
      max_light:    Math.round(maxL),
    },
  });
});

// 导出 CSV
app.get('/api/data/export', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const cutoff = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);

  const rows = dbAll(
    'SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id ASC',
    [cutoff]
  );

  let csv = '时间,电压(V),电流(A),功率(W),温度(°C),光照(W/m²)\n';
  for (const r of rows) {
    csv += `${r.created_at},${r.voltage},${r.current},${r.power},${r.temp},${r.light}\n`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=pv_data.csv');
  res.send('﻿' + csv);
});

// ============ 启动 ============
async function start() {
  await initDB();
  connectMQTT();
  app.listen(HTTP_PORT, () => {
    console.log(`\n☀️  光伏云平台已启动: http://localhost:${HTTP_PORT}`);
    console.log('   API: /api/data/latest | /api/data/history | /api/data/stats | /api/data/export');
    console.log('   等待 ESP8266 数据...\n');
  });
}

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
