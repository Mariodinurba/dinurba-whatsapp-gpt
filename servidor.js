// ¡Código corregido e integrado con consulta catastral!

const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();
const path = require('path');

const app = express();
app.use(express.json());
app.use('/descargas', express.static(path.join(__dirname, 'archivos')));

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = 'asst_WXEwYWFnqSP60RLicaGonUIi';

let db;
const openDB = async () => {
  if (!db) {
    db = await open({
      filename: './conversaciones.db',
      driver: sqlite3.Database
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS conversaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_id TEXT,
        numero TEXT,
        rol TEXT,
        contenido TEXT,
        timestamp INTEGER
      );

      CREATE TABLE IF NOT EXISTS hilos (
        numero TEXT PRIMARY KEY,
        thread_id TEXT
      );
    `);
  }
  return db;
};

const enviarMensajeWhatsApp = async (numero, texto, phone_id) => {
  const response = await axios.post(
    `https://graph.facebook.com/v18.0/${phone_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: numero,
      text: { body: '💬 ' + texto }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.messages?.[0]?.id || null;
};

const enviarPDFWhatsApp = async (numero, urlPDF, nombreArchivo, phone_id) => {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${phone_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: numero,
        type: 'document',
        document: {
          link: urlPDF,
          filename: nombreArchivo
        }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('📄 PDF enviado a', numero);
  } catch (error) {
    console.error('❌ Error al enviar PDF:', error.response?.data || error.message);
  }
};

const consultarPredio = async (clave) => {
  try {
    const response = await axios.get('https://web-production-753f.up.railway.app/consulta', {
      params: { clave }
    });
    return response.data;
  } catch (error) {
    console.error("❌ Error al consultar el predio:", error.response?.data || error.message);
    return { error: "No se pudo obtener la información del predio." };
  }
};

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (!body.object) return res.sendStatus(404);

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messageObject = value?.messages?.[0];
  const phone_id = value?.metadata?.phone_number_id;

  if (!messageObject) return res.sendStatus(200);

  const rawNumber = messageObject.from;
  const phoneNumber = rawNumber.replace(/^521/, '52');
  const messageText = messageObject.text?.body;
  const timestamp = parseInt(messageObject.timestamp);
  const wa_id = messageObject.id;
  const quotedId = messageObject.context?.id || null;

  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [wa_id, phoneNumber, 'user', messageText, timestamp]
    );

    const clave = messageText.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const esClaveValida = /^[A-Z]{2}\d{6}$/.test(clave) || /^[A-Z]{3}\d{6}$/.test(clave);

    if (esClaveValida) {
      const datos = await consultarPredio(clave);

      if (datos.error) {
        await enviarMensajeWhatsApp(phoneNumber, `❌ ${datos.error}`, phone_id);
      } else {
        const respuesta = `📄 *Información del predio:*
📍 Dirección: ${datos.direccion}
🏠 Colonia: ${datos.colonia}
👤 Propietario: ${datos.propietario}
📐 Superficie: ${datos.superficie}`;

        const respuestaId = await enviarMensajeWhatsApp(phoneNumber, respuesta, phone_id);

        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [respuestaId, phoneNumber, 'dinurba', respuesta, Date.now() / 1000]
        );
      }

      return res.sendStatus(200);
    }

    // ... (continúa el resto del flujo de OpenAI como ya lo tienes)

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('❌ Error:', msg);
    await enviarMensajeWhatsApp(phoneNumber, `❌ Error: ${msg}`, phone_id);
  }

  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verificado.');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
