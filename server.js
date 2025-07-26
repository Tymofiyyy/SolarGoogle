// server.js з Google Authentication
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Google OAuth2 Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:8080',
  credentials: true
}));
app.use(express.json());

// PostgreSQL підключення
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'solar_controller'}`,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// MQTT підключення з автентифікацією
const mqttOptions = {
  host: process.env.MQTT_HOST || 'localhost',
  port: process.env.MQTT_PORT || 1883,
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  protocol: process.env.MQTT_PROTOCOL || 'mqtt'
};

if (process.env.MQTT_USE_TLS === 'true') {
  mqttOptions.protocol = 'mqtts';
  mqttOptions.port = process.env.MQTT_TLS_PORT || 8883;
}

const mqttClient = mqtt.connect(mqttOptions);

// Зберігаємо статуси пристроїв в пам'яті для швидкого доступу
const deviceStatuses = new Map();
const deviceConfirmationCodes = new Map();

// MQTT обробники
mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  mqttClient.subscribe('solar/+/status');
  mqttClient.subscribe('solar/+/online');
});

mqttClient.on('error', (error) => {
  console.error('MQTT connection error:', error);
});

mqttClient.on('message', async (topic, message) => {
  const topicParts = topic.split('/');
  const deviceId = topicParts[1];
  const messageType = topicParts[2];
  
  try {
    if (messageType === 'status') {
      const status = JSON.parse(message.toString());
      
      if (status.confirmationCode) {
        deviceConfirmationCodes.set(deviceId, status.confirmationCode);
        console.log(`Received confirmation code for ${deviceId}: ${status.confirmationCode}`);
      }
      
      deviceStatuses.set(deviceId, {
        ...status,
        lastSeen: new Date(),
        online: true
      });
      
      const deviceExists = await pool.query(
        'SELECT id FROM devices WHERE device_id = $1',
        [deviceId]
      );
      
      if (deviceExists.rows.length > 0) {
        await saveDeviceStatus(deviceId, status);
      }
    } else if (messageType === 'online') {
      const isOnline = message.toString() === 'true';
      const currentStatus = deviceStatuses.get(deviceId) || {};
      deviceStatuses.set(deviceId, {
        ...currentStatus,
        online: isOnline,
        lastSeen: new Date()
      });
    }
  } catch (error) {
    console.error(`Error processing MQTT (${topic}):`, error);
  }
});

// Middleware для перевірки JWT токена
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// API Routes

// Google OAuth2 login
app.post('/api/auth/google', async (req, res) => {
  const client = await pool.connect();
  try {
    const { credential } = req.body;
    
    // Verify Google token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    
    const payload = ticket.getPayload();
    const googleId = payload['sub'];
    const email = payload['email'];
    const name = payload['name'];
    const picture = payload['picture'];
    
    await client.query('BEGIN');
    
    // Check if user exists
    let user = await client.query(
      'SELECT * FROM users WHERE google_id = $1',
      [googleId]
    );
    
    if (user.rows.length === 0) {
      // Create new user
      user = await client.query(
        `INSERT INTO users (google_id, email, name, picture) 
         VALUES ($1, $2, $3, $4) 
         RETURNING *`,
        [googleId, email, name, picture]
      );
    } else {
      // Update user info
      user = await client.query(
        `UPDATE users 
         SET email = $2, name = $3, picture = $4, last_login = CURRENT_TIMESTAMP
         WHERE google_id = $1
         RETURNING *`,
        [googleId, email, name, picture]
      );
    }
    
    await client.query('COMMIT');
    
    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.rows[0].id,
        googleId: user.rows[0].google_id,
        email: user.rows[0].email
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: {
        id: user.rows[0].id,
        email: user.rows[0].email,
        name: user.rows[0].name,
        picture: user.rows[0].picture
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error in Google auth:', error);
    res.status(500).json({ error: 'Authentication failed' });
  } finally {
    client.release();
  }
});

// Get current user info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, picture FROM users WHERE id = $1',
      [req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all devices for authenticated user
app.get('/api/devices', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT d.*, ud.is_owner, ud.added_at
       FROM devices d
       JOIN user_devices ud ON d.id = ud.device_id
       WHERE ud.user_id = $1
       ORDER BY ud.added_at DESC`,
      [req.user.id]
    );
    
    const devices = result.rows.map(device => ({
      ...device,
      status: deviceStatuses.get(device.device_id) || { online: false }
    }));
    
    res.json(devices);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add new device
app.post('/api/devices', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { deviceId, confirmationCode, name } = req.body;
    
    // Verify confirmation code
    const storedCode = deviceConfirmationCodes.get(deviceId);
    if (!storedCode || storedCode !== confirmationCode) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid confirmation code or device not found' });
    }
    
    // Check if device exists
    let deviceResult = await client.query(
      'SELECT id FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    let deviceDbId;
    let isNewDevice = false;
    
    if (deviceResult.rows.length === 0) {
      // Create new device
      deviceResult = await client.query(
        'INSERT INTO devices (device_id, name) VALUES ($1, $2) RETURNING id',
        [deviceId, name || `Solar Controller ${deviceId.slice(-4)}`]
      );
      deviceDbId = deviceResult.rows[0].id;
      isNewDevice = true;
    } else {
      deviceDbId = deviceResult.rows[0].id;
    }
    
    // Check if user already has access
    const accessCheck = await client.query(
      'SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [req.user.id, deviceDbId]
    );
    
    if (accessCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You already have access to this device' });
    }
    
    // Add user-device relationship
    await client.query(
      'INSERT INTO user_devices (user_id, device_id, is_owner) VALUES ($1, $2, $3)',
      [req.user.id, deviceDbId, isNewDevice]
    );
    
    await client.query('COMMIT');
    
    // Return full device info
    const fullDevice = await client.query(
      `SELECT d.*, ud.is_owner, ud.added_at
       FROM devices d
       JOIN user_devices ud ON d.id = ud.device_id
       WHERE d.id = $1 AND ud.user_id = $2`,
      [deviceDbId, req.user.id]
    );
    
    res.json({
      ...fullDevice.rows[0],
      status: deviceStatuses.get(deviceId) || { online: false }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding device:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Delete device (remove user access)
app.delete('/api/devices/:deviceId', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { deviceId } = req.params;
    
    const deviceResult = await client.query(
      'SELECT id FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    if (deviceResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Device not found' });
    }
    
    const deviceDbId = deviceResult.rows[0].id;
    
    // Remove user-device relationship
    await client.query(
      'DELETE FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [req.user.id, deviceDbId]
    );
    
    // Check if any users remain
    const remainingUsers = await client.query(
      'SELECT COUNT(*) FROM user_devices WHERE device_id = $1',
      [deviceDbId]
    );
    
    // If no users remain, delete device
    if (parseInt(remainingUsers.rows[0].count) === 0) {
      await client.query(
        'DELETE FROM devices WHERE id = $1',
        [deviceDbId]
      );
    }
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting device:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Control device
app.post('/api/devices/:deviceId/control', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { command, state } = req.body;
    
    // Verify user has access to device
    const accessCheck = await pool.query(
      `SELECT 1 FROM user_devices ud
       JOIN devices d ON d.id = ud.device_id
       WHERE ud.user_id = $1 AND d.device_id = $2`,
      [req.user.id, deviceId]
    );
    
    if (accessCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const topic = `solar/${deviceId}/command`;
    const payload = JSON.stringify({ command, state });
    
    mqttClient.publish(topic, payload);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error controlling device:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Share device with another user
app.post('/api/devices/:deviceId/share', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { deviceId } = req.params;
    const { email } = req.body;
    
    // Verify owner has rights
    const ownerResult = await client.query(
      `SELECT ud.is_owner 
       FROM user_devices ud
       JOIN devices d ON d.id = ud.device_id
       WHERE ud.user_id = $1 AND d.device_id = $2`,
      [req.user.id, deviceId]
    );
    
    if (ownerResult.rows.length === 0 || !ownerResult.rows[0].is_owner) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Only owner can share device' });
    }
    
    // Find target user by email
    const targetUser = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    
    if (targetUser.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found. They need to login first.' });
    }
    
    const targetUserId = targetUser.rows[0].id;
    
    // Find device
    const deviceResult = await client.query(
      'SELECT id FROM devices WHERE device_id = $1',
      [deviceId]
    );
    
    const deviceDbId = deviceResult.rows[0].id;
    
    // Check existing access
    const existingAccess = await client.query(
      'SELECT * FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [targetUserId, deviceDbId]
    );
    
    if (existingAccess.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User already has access to this device' });
    }
    
    // Add access
    await client.query(
      'INSERT INTO user_devices (user_id, device_id, is_owner) VALUES ($1, $2, false)',
      [targetUserId, deviceDbId]
    );
    
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error sharing device:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mqtt: mqttClient.connected,
    timestamp: new Date()
  });
});

// Helper functions
async function saveDeviceStatus(deviceId, status) {
  try {
    await pool.query(
      `INSERT INTO device_history (device_id, relay_state, wifi_rssi, uptime, free_heap)
       VALUES ($1, $2, $3, $4, $5)`,
      [deviceId, status.relayState, status.wifiRSSI, status.uptime, status.freeHeap]
    );
  } catch (error) {
    console.error('Error saving device status:', error);
  }
}

// Initialize database
async function initDatabase() {
  try {
    console.log('Initializing database...');
    
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        picture TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_devices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
        is_owner BOOLEAN DEFAULT false,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, device_id)
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_history (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255),
        relay_state BOOLEAN,
        wifi_rssi INTEGER,
        uptime INTEGER,
        free_heap INTEGER,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_device_history_device_id_timestamp 
      ON device_history(device_id, timestamp DESC)
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_devices_user_id 
      ON user_devices(user_id)
    `);
    
    console.log('Database initialized successfully!');
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1);
  }
}

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDatabase();
});

// Periodic status check
setInterval(() => {
  const now = new Date();
  deviceStatuses.forEach((status, deviceId) => {
    if (now - status.lastSeen > 30000) {
      status.online = false;
    }
  });
}, 5000);

// Clean old data every 24 hours
setInterval(async () => {
  try {
    await pool.query(
      'DELETE FROM device_history WHERE timestamp < NOW() - INTERVAL \'30 days\''
    );
    console.log('Old data cleaned');
  } catch (error) {
    console.error('Error cleaning old data:', error);
  }
}, 24 * 60 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received');
  mqttClient.end();
  pool.end();
  process.exit(0);
});