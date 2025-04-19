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
      )
    `);
  }
  return db;
};

const enviarMensajeWhatsApp = async (numero, texto, phone_id) => {
  await axios.post(
    `https://graph.facebook.com/v18.0/${phone_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: numero,
      text: { body: '🤖 ' + texto }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
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
  const tipo = messageObject.type || 'desconocido';

  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    // Registramos el mensaje del usuario en la base de datos
    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [wa_id, phoneNumber, 'user', messageText, timestamp]
    );

    let info = `🧾 wa_id recibido:\n${wa_id}\n📦 Tipo de contenido: ${tipo}`;
    if (quotedId) {
      info += `\n📎 quotedId recibido:\n${quotedId}\n🔍 Buscando mensaje con wa_id = ${quotedId}`;
    }
    await enviarMensajeWhatsApp(phoneNumber, info, phone_id);

    // Verificar si el mensaje actual está citando otro mensaje
    if (quotedId) {
      // Primero buscamos el mensaje citado por wa_id exacto
      let citado = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
      
      // Si no lo encontramos, esperamos un poco y volvemos a intentar
      if (!citado) {
        await new Promise(resolve => setTimeout(resolve, 300));
        citado = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
      }
      
      // Si aún no lo encontramos, intentamos una búsqueda más amplia para mensajes del bot
      // Los IDs de WhatsApp pueden variar y los mensajes del bot podrían tener un formato diferente
      if (!citado) {
        // Consulta para encontrar el mensaje del bot más cercano en tiempo
        const posiblesMensajesBot = await db.all(`
          SELECT * FROM conversaciones 
          WHERE numero = ? 
          AND (rol = 'dinurba' OR rol = 'assistant')
          ORDER BY timestamp DESC LIMIT 5
        `, [phoneNumber]);
        
        // Enviar información de depuración sobre los posibles mensajes encontrados
        if (posiblesMensajesBot.length > 0) {
          let debugInfo = `🔍 Buscando entre los últimos ${posiblesMensajesBot.length} mensajes del bot:\n`;
          for (const msg of posiblesMensajesBot) {
            debugInfo += `ID: ${msg.wa_id.substring(0, 10)}..., Contenido: "${msg.contenido.substring(0, 30)}..."\n`;
          }
          await enviarMensajeWhatsApp(phoneNumber, debugInfo, phone_id);
          
          // Utilizamos el más reciente como una aproximación
          citado = posiblesMensajesBot[0];
        } else {
          await enviarMensajeWhatsApp(phoneNumber, `⚠️ No se encontraron mensajes recientes del bot para comparar`, phone_id);
        }
      }

      // Si encontramos el mensaje citado (ya sea directamente o por aproximación), lo procesamos
      if (citado) {
        // Determinar quién es el autor del mensaje citado
        const quien = citado.rol === 'user' ? 'el cliente'
                    : (citado.rol === 'dinurba' || citado.rol === 'assistant') ? 'Dinurba'
                    : 'el sistema';

        await enviarMensajeWhatsApp(phoneNumber, `✅ Mensaje citado encontrado (${citado.rol}):\n"${citado.contenido}"`, phone_id);

        // Creamos un bloque interpretativo para cualquier tipo de mensaje citado
        const bloque = `El cliente citó un mensaje anterior de ${quien}: "${citado.contenido}". Luego escribió: "${messageText}". Interpreta la relación entre ambos.`;

        // Guardamos el bloque interpretativo como mensaje de sistema
        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [`system-${wa_id}`, phoneNumber, 'system', bloque, timestamp]
        );

        await enviarMensajeWhatsApp(phoneNumber, `🤖 Bloque system guardado:\n${bloque}`, phone_id);

        // Marcamos el mensaje del usuario como "omitido" para que no se duplique en el contexto
        await db.run('UPDATE conversaciones SET rol = ? WHERE wa_id = ?', ['user_omitido', wa_id]);
      } else {
        await enviarMensajeWhatsApp(phoneNumber, `⚠️ No se encontró ningún mensaje citado con wa_id = ${quotedId}`, phone_id);
      }
    }

    // Obtener mensajes de los últimos 6 meses
    const seisMeses = 60 * 60 * 24 * 30 * 6;
    const desde = Date.now() / 1000 - seisMeses;

    // Buscar los últimos 30 mensajes del cliente
    const mensajesCliente = await db.all(
      `SELECT * FROM conversaciones WHERE numero = ? AND rol = 'user' AND timestamp >= ? ORDER BY timestamp DESC LIMIT 30`,
      [phoneNumber, desde]
    );

    // Determinar el timestamp del mensaje más antiguo para construir el contexto
    const primerTimestamp = mensajesCliente.length > 0
      ? mensajesCliente[mensajesCliente.length - 1].timestamp
      : Date.now() / 1000;

    // Obtener todos los mensajes desde el timestamp más antiguo
    const allMessages = await db.all(
      `SELECT * FROM conversaciones WHERE numero = ? AND timestamp >= ? ORDER BY timestamp ASC`,
      [phoneNumber, primerTimestamp]
    );

    // Filtrar los mensajes marcados como "omitidos" y mapear a formato de API de OpenAI
    const contexto = allMessages
      .filter(msg => msg.rol !== 'user_omitido')
      .map(msg => ({
        role: msg.rol === 'system' ? 'user' : (msg.rol === 'user' ? 'user' : 'assistant'),
        content: msg.contenido
      }));

    await enviarMensajeWhatsApp(phoneNumber, `🧠 Contexto enviado a la IA:\n\`\`\`\n${JSON.stringify(contexto, null, 2)}\n\`\`\``, phone_id);

    // Crear un nuevo hilo en OpenAI
    const thread = await axios.post('https://api.openai.com/v1/threads', {}, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      }
    });

    const thread_id = thread.data.id;

    // Añadir todos los mensajes del contexto al hilo
    for (const msg of contexto) {
      await axios.post(
        `https://api.openai.com/v1/threads/${thread_id}/messages`,
        { role: msg.role, content: msg.content },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );
    }

    // Ejecutar el asistente en el hilo
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

    // Esperar a que termine la ejecución
    let status = 'queued';
    while (status !== 'completed' && status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 1000));
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
    }

    // Procesar y enviar la respuesta
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

      await enviarMensajeWhatsApp(phoneNumber, texto.slice(0, 4096), phone_id);

      // Guardar la respuesta del asistente en la base de datos
      await db.run(
        'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
        [run.data.id, phoneNumber, 'dinurba', texto, Date.now() / 1000]
      );
    } else {
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
