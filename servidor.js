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
  console.log('📤 Enviando mensaje por WhatsApp:', texto);
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
  const quotedId = messageObject.context?.id || null;

  console.log('📥 Mensaje recibido:', { phoneNumber, messageText, wa_id, quotedId });

  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [wa_id, phoneNumber, 'user', messageText, timestamp]
    );
    console.log('✅ Mensaje guardado en la base de datos.');

    let systemBlock = null;
    if (quotedId) {
      console.log('🧩 Mensaje cita otro anterior:', quotedId);
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

        console.log('📋 Bloque system creado y guardado.');
      }
    }

    let hilo = await db.get('SELECT thread_id FROM hilos WHERE numero = ?', [phoneNumber]);
    let thread_id;

    if (hilo) {
      thread_id = hilo.thread_id;
      console.log('🔗 Hilo existente encontrado:', thread_id);
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
      console.log('🆕 Nuevo hilo creado:', thread_id);
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
      console.log('📨 Bloque system enviado a OpenAI.');
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
    console.log('📨 Mensaje del cliente enviado a OpenAI.');

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
    console.log('🏁 Run iniciado en OpenAI:', run.data.id);

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

      status = check.data.status;
      console.log(`🔄 Estado del run (intento ${intentos + 1}):`, status);

      if (check.data.required_action?.submit_tool_outputs) {
        console.log('🛠️ El Assistant requiere ejecutar herramientas.');
        for (const tool of check.data.required_action.submit_tool_outputs.tool_calls) {
          if (tool.function?.name === 'consultar_predio') {
            const { clave } = JSON.parse(tool.function.arguments);
            console.log('🔍 Ejecutando consultar_predio para clave:', clave);

            try {
              const respuesta = await axios.get(`http://localhost:8000/consulta?clave=${clave}`);
              const datos = respuesta.data;
              console.log('✅ Resultado de consulta_predio:', datos);

              if (datos.error) {
                console.error('❌ No se encontró información para clave:', clave);
                await enviarMensajeWhatsApp(phoneNumber, `❌ No se encontró información para la clave catastral: ${clave}`, phone_id);
              } else {
                const mensaje = `📄 *Información del predio consultado:*

` +
                  `🔑 Clave: ${datos.clave_catastral}
` +
                  `👤 Propietario: ${datos.propietario}
` +
                  `📍 Dirección: ${datos.direccion}
` +
                  `🏘️ Colonia: ${datos.colonia}
` +
                  `📐 Superficie: ${datos.superficie}`;

                await enviarMensajeWhatsApp(phoneNumber, mensaje, phone_id);
              }

              await axios.post(
                `https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}/submit_tool_outputs`,
                {
                  tool_outputs: [
                    {
                      tool_call_id: tool.id,
                      output: `Consulta realizada.`
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
              console.log('📤 Resultado de consultar_predio enviado a OpenAI.');
              intentos = 0;
            } catch (e) {
              console.error('❌ Error ejecutando consultar_predio:', e.message);
            }
          }
        }
      }
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

      console.log('📨 Respuesta final del Assistant:', texto);

      const respuestaId = await enviarMensajeWhatsApp(phoneNumber, texto.slice(0, 4096), phone_id);
      await db.run(
        'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
        [respuestaId, phoneNumber, 'dinurba', texto, Date.now() / 1000]
      );
      console.log('✅ Mensaje final enviado al cliente.');
    } else {
      console.log('❌ El Assistant falló al completar el run.');
      await enviarMensajeWhatsApp(phoneNumber, '❌ El Assistant falló al procesar tu mensaje.', phone_id);
    }
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('❌ Error general:', msg);
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
