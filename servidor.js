// === servidor.js FINAL (igual que el que sí funciona, solo agrega envío de URL) ===

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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

let db;
const openDB = async () => {
  if (!db) {
    db = await open({ filename: './conversaciones.db', driver: sqlite3.Database });
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

  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    await db.run('INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)', [wa_id, phoneNumber, 'user', messageText, timestamp]);

    let hilo = await db.get('SELECT thread_id FROM hilos WHERE numero = ?', [phoneNumber]);
    let thread_id;

    if (hilo) {
      thread_id = hilo.thread_id;
    } else {
      const nuevaConversacion = await axios.post('https://api.openai.com/v1/threads', {}, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      });
      thread_id = nuevaConversacion.data.id;
      await db.run('INSERT INTO hilos (numero, thread_id) VALUES (?, ?)', [phoneNumber, thread_id]);
    }

    await axios.post(`https://api.openai.com/v1/threads/${thread_id}/messages`, { role: 'user', content: messageText }, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      }
    });

    const run = await axios.post(`https://api.openai.com/v1/threads/${thread_id}/runs`, { assistant_id: ASSISTANT_ID }, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      }
    });

    let status = 'queued';
    let intentos = 0;

    while (status !== 'completed' && status !== 'failed' && intentos < 20) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const check = await axios.get(`https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}`, {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2'
        }
      });

      if (check.data.required_action?.submit_tool_outputs) {
        for (const tool of check.data.required_action.submit_tool_outputs.tool_calls) {
          if (tool.function?.name === 'consultar_predio') {
            const { clave } = JSON.parse(tool.function.arguments);
            try {
              const urlConsulta = `http://localhost:8000/consulta?clave=${clave}`;

              // ✉️ Enviar URL por WhatsApp (adicional, sin afectar flujo)
              await enviarMensajeWhatsApp(phoneNumber, `🔗 Link de consulta generado:
${urlConsulta}`, phone_id);

              const respuesta = await axios.get(urlConsulta);
              const datos = respuesta.data;

              if (datos.error) {
                await enviarMensajeWhatsApp(phoneNumber, `❌ No se encontró información para la clave: ${clave}`, phone_id);
                await axios.post(`https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}/submit_tool_outputs`, {
                  tool_outputs: [
                    { tool_call_id: tool.id, output: 'No se encontró información disponible.' }
                  ]
                }, {
                  headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                    'OpenAI-Beta': 'assistants=v2'
                  }
                });
                return;
              }

              const mensaje = `📄 *Información del predio:*

🔑 Clave: ${datos.clave_catastral}
👤 Propietario: ${datos.propietario}
📍 Dirección: ${datos.direccion}
🏘️ Colonia: ${datos.colonia}
📐 Superficie: ${datos.superficie}`;

              await enviarMensajeWhatsApp(phoneNumber, mensaje, phone_id);

              await axios.post(`https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}/submit_tool_outputs`, {
                tool_outputs: [
                  { tool_call_id: tool.id, output: 'Consulta realizada exitosamente.' }
                ]
              }, {
                headers: {
                  Authorization: `Bearer ${OPENAI_API_KEY}`,
                  'Content-Type': 'application/json',
                  'OpenAI-Beta': 'assistants=v2'
                }
              });

            } catch (error) {
              console.error('❌ Error en la consulta del predio:', error.message);
              await enviarMensajeWhatsApp(phoneNumber, '❌ Error al consultar el predio.', phone_id);
            }
          }
        }
      }

      status = check.data.status;
      intentos++;
    }

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('❌ Error general:', msg);
  }

  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado.');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
