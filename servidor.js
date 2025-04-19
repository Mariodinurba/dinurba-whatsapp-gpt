const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
app.use(express.json());

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

        await db.run(
          'UPDATE conversaciones SET rol = ? WHERE wa_id = ?',
          ['user_omitido', wa_id]
        );
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

    const run = await axios.post(
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
      await new Promise(resolve => setTimeout(resolve, 500));
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

      if (respuesta?.tool_calls) {
        for (const tool of respuesta.tool_calls) {
          console.log('🛠 Ejecutando tool_call:', tool);

          if (tool.function?.name === 'enviar_pdf') {
            try {
              const { url, nombre } = JSON.parse(tool.function.arguments);
              await enviarPDFWhatsApp(phoneNumber, url, nombre, phone_id);

              // Confirmar a OpenAI que se ejecutó correctamente
              await axios.post(
                `https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}/submit_tool_outputs`,
                {
                  tool_outputs: [
                    {
                      tool_call_id: tool.id,
                      output: "PDF enviado correctamente."
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
              ).then(() => {
                console.log('✅ Tool output enviado correctamente.');
              }).catch(err => {
                console.error('❌ Error al enviar tool output:', err.response?.data || err.message);
              });
            } catch (e) {
              console.error('❌ Error ejecutando tool_call:', e);
            }
          }
        }
      } = JSON.parse(tool.function.arguments);
            await enviarPDFWhatsApp(phoneNumber, url, nombre, phone_id);

            // Confirmar a OpenAI que la herramienta se ejecutó
            await axios.post(
              `https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}/submit_tool_outputs`,
              {
                tool_outputs: [
                  {
                    tool_call_id: tool.id,
                    output: "PDF enviado correctamente."
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
            ).then(() => {
              console.log('✅ Tool output enviado correctamente.');
            }).catch(err => {
              console.error('❌ Error al enviar tool output:', err.response?.data || err.message);
            });
          }
        }
      }

      const respuestaId = await enviarMensajeWhatsApp(phoneNumber, texto.slice(0, 4096), phone_id);

      await db.run(
        'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
        [respuestaId, phoneNumber, 'dinurba', texto, Date.now() / 1000]
      );
    } else {
      console.log('🧪 RUN ID:', run.data.id);
const debug = await axios.get(
  `https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}`,
  {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'assistants=v2'
    }
  }
);
console.log('🧠 RUN STATUS:', debug.data.status);
console.log('🧠 RUN OUTPUT:', JSON.stringify(debug.data, null, 2));

await enviarMensajeWhatsApp(phoneNumber, '❌ El Assistant falló al procesar tu mensaje.', phone_id);
    }
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
