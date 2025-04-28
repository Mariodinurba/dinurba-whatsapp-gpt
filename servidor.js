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
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`; // URL base para generar enlaces

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

// Función para enviar un enlace como mensaje interactivo por WhatsApp
const enviarEnlaceWhatsApp = async (numero, titulo, descripcion, url, phone_id) => {
  const response = await axios.post(
    `https://graph.facebook.com/v18.0/${phone_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: numero,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: {
          type: 'text',
          text: '🔗 Enlace de consulta'
        },
        body: {
          text: `*${titulo}*\n\n${descripcion}`
        },
        action: {
          buttons: [
            {
              type: 'url',
              url: url,
              text: 'Ver consulta'
            }
          ]
        }
      }
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
  const quotedId = messageObject.context?.id || null;

  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [wa_id, phoneNumber, 'user', messageText, timestamp]
    );

    let systemBlock = null;
    if (quotedId) {
      let citado = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
      if (!citado) {
        await new Promise(resolve => setTimeout(resolve, 300));
        citado = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
      }

      if (['user', 'dinurba', 'assistant', 'system'].includes(citado?.rol)) {
        const quien = citado.rol === 'user' ? 'el cliente' : citado.rol === 'dinurba' || citado.rol === 'assistant' ? 'Dinurba' : 'el sistema';
        systemBlock = `El cliente citó un mensaje anterior de ${quien}: "${citado.contenido}". Y escribió sobre el mensaje citado: "${messageText}".`;

        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [`system-${wa_id}`, phoneNumber, 'system', systemBlock, timestamp]
        );

        await db.run('UPDATE conversaciones SET rol = ? WHERE wa_id = ?', ['user_omitido', wa_id]);
      }
    }

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

    if (systemBlock) {
      await axios.post(
        `https://api.openai.com/v1/threads/${thread_id}/messages`,
        { role: 'user', content: systemBlock },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );
    }

    await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/messages`,
      { role: 'user', content: messageText },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    let run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      { assistant_id: ASSISTANT_ID },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    let status = 'queued';
    let intentos = 0;
    while (status !== 'completed' && status !== 'failed' && intentos < 20) {
      await new Promise(resolve => setTimeout(resolve, 800));
      const check = await axios.get(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );

      if (check.data.required_action?.submit_tool_outputs) {
        for (const tool of check.data.required_action.submit_tool_outputs.tool_calls) {
          if (tool.function?.name === 'consultar_predio') {
            const { clave } = JSON.parse(tool.function.arguments);
            try {
              const respuesta = await axios.get(`http://localhost:8000/consulta?clave=${clave}`);
              const datos = respuesta.data;

              if (datos.error) {
                await enviarMensajeWhatsApp(phoneNumber, `❌ No se encontró información para la clave catastral: ${clave}`, phone_id);
              } else {
                const mensaje = `📄 *Información del predio consultado:*\n\n` +
                  `🔑 Clave: ${datos.clave_catastral}\n` +
                  `👤 Propietario: ${datos.propietario}\n` +
                  `📍 Dirección: ${datos.direccion}\n` +
                  `🏘️ Colonia: ${datos.colonia}\n` +
                  `📐 Superficie: ${datos.superficie}`;

                await enviarMensajeWhatsApp(phoneNumber, mensaje, phone_id);
                
                // Generar y enviar el enlace de consulta
                const enlaceConsulta = `${BASE_URL}/consulta-publica?clave=${clave}`;
                await enviarEnlaceWhatsApp(
                  phoneNumber,
                  `Consulta catastral: ${clave}`,
                  `Accede a la información completa del predio con clave catastral ${clave}.`,
                  enlaceConsulta,
                  phone_id
                );
              }

              await axios.post(
                `https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}/submit_tool_outputs`,
                {
                  tool_outputs: [
                    {
                      tool_call_id: tool.id,
                      output: `Consulta realizada. Datos obtenidos:\nClave: ${datos.clave_catastral}\nPropietario: ${datos.propietario}\nDirección: ${datos.direccion}\nColonia: ${datos.colonia}\nSuperficie: ${datos.superficie}`
                    }
                  ]
                },
                {
                  headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json',
                    'OpenAI-Beta': 'assistants=v2'
                  }
                }
              );

              intentos = 0;
            } catch (e) {
              console.error('❌ Error ejecutando consultar_predio:', e.message);
            }
          }
        }
      }

      status = check.data.status;
      intentos++;
    }

    if (status === 'completed') {
      const messages = await axios.get(
        `https://api.openai.com/v1/threads/${thread_id}/messages`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );

      const respuesta = messages.data.data.find(m => m.role === 'assistant');
      const texto = respuesta?.content?.[0]?.text?.value || 'No hubo respuesta.';

      const respuestaId = await enviarMensajeWhatsApp(phoneNumber, texto.slice(0, 4096), phone_id);
      await db.run(
        'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
        [respuestaId, phoneNumber, 'dinurba', texto, Date.now() / 1000]
      );
    } else {
      console.log('🧠 RUN STATUS:', status);
      await enviarMensajeWhatsApp(phoneNumber, '❌ El Assistant falló al procesar tu mensaje.', phone_id);
    }
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('❌ Error:', msg);
    await enviarMensajeWhatsApp(phoneNumber, `❌ Error: ${msg}`, phone_id);
  }

  res.sendStatus(200);
});

// Nueva ruta para la consulta pública
app.get('/consulta-publica', async (req, res) => {
  const clave = req.query.clave;
  if (!clave) {
    return res.status(400).send('Se requiere una clave catastral');
  }

  try {
    const respuesta = await axios.get(`http://localhost:8000/consulta?clave=${clave}`);
    const datos = respuesta.data;

    if (datos.error) {
      return res.status(404).send(`No se encontró información para la clave catastral: ${clave}`);
    }

    // Envía una página HTML con la información del predio
    res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Consulta Catastral | ${datos.clave_catastral}</title>
          <style>
              body {
                  font-family: Arial, sans-serif;
                  line-height: 1.6;
                  max-width: 800px;
                  margin: 0 auto;
                  padding: 20px;
                  background-color: #f5f5f5;
              }
              .container {
                  background-color: white;
                  border-radius: 10px;
                  padding: 20px;
                  box-shadow: 0 0 10px rgba(0,0,0,0.1);
              }
              h1 {
                  color: #2c3e50;
                  border-bottom: 1px solid #eee;
                  padding-bottom: 10px;
              }
              .info-grid {
                  display: grid;
                  grid-template-columns: 1fr 2fr;
                  gap: 10px;
              }
              .label {
                  font-weight: bold;
                  color: #555;
              }
              .value {
                  color: #333;
              }
              .footer {
                  margin-top: 30px;
                  text-align: center;
                  font-size: 0.9em;
                  color: #777;
              }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Información Catastral</h1>
              <div class="info-grid">
                  <div class="label">Clave Catastral:</div>
                  <div class="value">${datos.clave_catastral}</div>
                  
                  <div class="label">Propietario:</div>
                  <div class="value">${datos.propietario}</div>
                  
                  <div class="label">Dirección:</div>
                  <div class="value">${datos.direccion}</div>
                  
                  <div class="label">Colonia:</div>
                  <div class="value">${datos.colonia}</div>
                  
                  <div class="label">Superficie:</div>
                  <div class="value">${datos.superficie}</div>
              </div>
          </div>
          <div class="footer">
              <p>Esta información es de carácter público. Consulta realizada el ${new Date().toLocaleDateString()}.</p>
          </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Error al realizar consulta pública:', error.message);
    res.status(500).send('Error al procesar la consulta');
  }
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
