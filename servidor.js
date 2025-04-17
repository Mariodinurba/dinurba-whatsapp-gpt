const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const VERIFY_TOKEN = "dinurba123"; // El mismo que usaste en la página de Meta
const WHATSAPP_TOKEN = "EAAJnADpE7ZBgBO2JmgqjJfM40XoEv6ktgr7nfZBQgkanHzn8k5R6SpTB5ZCEEe4zy2ZCKOan4AtkFbTjKSU5CpZC5yXWSXjFQVxzj9ImlV6eJBJZB4bWJeh5NIYDjUhOaLuvJgRZCAOY1pzyXpgnmKsFvYokauFEfPQWgbG6DBmrGMzPstnZCeq9MPio3wtpvsTxjMuLsoDMg42RdKkAouwoljnW"; // <-- Reemplaza esto con tu token temporal
const PHONE_NUMBER_ID = "559929630545964"; // Este es el ID de número que aparece en Meta

// Verificación de webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('🟢 Webhook verificado correctamente.');
    res.status(200).send(challenge);
  } else {
    console.log('🔴 Error al verificar webhook.');
    res.sendStatus(403);
  }
});

// Recepción de mensajes
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (
    body.object === 'whatsapp_business_account' &&
    body.entry &&
    body.entry[0].changes &&
    body.entry[0].changes[0].value.messages
  ) {
    const message = body.entry[0].changes[0].value.messages[0];
    const from = message.from; // Número del usuario que envió el mensaje
    const msgBody = message.text?.body;

    console.log(`📩 Mensaje recibido de ${from}: ${msgBody}`);

    // Enviar respuesta automática
    try {
      await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        data: {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: '🤖 Hola, gracias por escribir a Dinurba. En breve te atenderemos.' }
        }
      });

      console.log('✅ Respuesta enviada');
    } catch (error) {
      console.error('❌ Error al enviar mensaje:', error.response?.data || error.message);
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Puerto para Railway
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
