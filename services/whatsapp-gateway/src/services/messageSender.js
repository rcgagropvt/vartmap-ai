// whatsapp-gateway/src/services/messageSender.js

const axios = require('axios');

class WhatsAppMessageSender {
  constructor(config, redis, logger) {
    this.graphApiUrl = `https://graph.facebook.com/v21.0/${config.PHONE_NUMBER_ID}/messages`;
    this.accessToken = config.META_ACCESS_TOKEN;
    this.redis = redis;
    this.logger = logger;
    this.maxRetries = 3;
  }

  /**
   * Send a message to a farmer.
   * Supports both phone number and BSUID routing.
   * Phone number takes precedence when both are available.
   */
  async sendMessage(farmer, messagePayload) {
    const headers = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };

    // Build recipient fields (BSUID-aware)
    const recipientFields = this._buildRecipientFields(farmer);

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...recipientFields,
      ...messagePayload
    };

    return this._sendWithRetry(body, headers, farmer);
  }

  _buildRecipientFields(farmer) {
    // Strategy: use phone if available (takes precedence per Meta docs),
    // fall back to BSUID for username-adopters without phone
    if (farmer.phone) {
      return { to: farmer.phone };
    }
    if (farmer.bsuid) {
      return { recipient: farmer.bsuid };
    }
    throw new Error(`No contact method for farmer ${farmer.id}`);
  }

  async sendTextMessage(farmer, text) {
    return this.sendMessage(farmer, {
      type: 'text',
      text: { body: text }
    });
  }

  async sendInteractiveButtons(farmer, bodyText, buttons) {
    return this.sendMessage(farmer, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((btn, idx) => ({
            type: 'reply',
            reply: { id: btn.id, title: btn.title }
          }))
        }
      }
    });
  }

  async sendInteractiveList(farmer, bodyText, buttonText, sections) {
    return this.sendMessage(farmer, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonText,
          sections: sections
        }
      }
    });
  }

  async sendTemplate(farmer, templateName, language, components) {
    return this.sendMessage(farmer, {
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: components || []
      }
    });
  }

  async sendImage(farmer, imageUrl, caption) {
    return this.sendMessage(farmer, {
      type: 'image',
      image: {
        link: imageUrl,
        caption: caption || ''
      }
    });
  }

  async sendAudio(farmer, audioUrl) {
    return this.sendMessage(farmer, {
      type: 'audio',
      audio: { link: audioUrl }
    });
  }

  async _sendWithRetry(body, headers, farmer, attempt = 1) {
    try {
      const response = await axios.post(this.graphApiUrl, body, {
        headers,
        timeout: 10000
      });

      const result = response.data;

      // Extract and store BSUID from response if present
      if (result.contacts?.[0]?.user_id && farmer.id) {
        const responseBsuid = result.contacts[0].user_id;
        if (!farmer.bsuid || farmer.bsuid !== responseBsuid) {
          // Update farmer BSUID (async, don't block)
          this._updateFarmerBsuid(farmer.id, responseBsuid).catch(err =>
            this.logger.error({ err, farmerId: farmer.id }, 'Failed to update BSUID')
          );
        }
      }

      return {
        success: true,
        messageId: result.messages?.[0]?.id,
        bsuid: result.contacts?.[0]?.user_id
      };
    } catch (error) {
      const statusCode = error.response?.status;
      const errorData = error.response?.data?.error;

      // Rate limiting — wait and retry
      if (statusCode === 429 && attempt <= this.maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000; // exponential backoff
        this.logger.warn({
          attempt,
          waitTime,
          farmerId: farmer.id
        }, 'Rate limited, retrying');
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this._sendWithRetry(body, headers, farmer, attempt + 1);
      }

      // BSUID not yet supported for this message type (error 131062)
      if (errorData?.code === 131062) {
        this.logger.warn({
          farmerId: farmer.id,
          error: errorData
        }, 'BSUID not supported for this message type, need phone number');
        // This is expected for auth templates sent to BSUID
        // Try requesting phone via REQUEST_CONTACT_INFO template
      }

      // Server errors — retry
      if (statusCode >= 500 && attempt <= this.maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        return this._sendWithRetry(body, headers, farmer, attempt + 1);
      }

      this.logger.error({
        statusCode,
        errorData,
        farmerId: farmer.id,
        attempt
      }, 'Failed to send WhatsApp message');

      return {
        success: false,
        error: errorData || error.message,
        statusCode
      };
    }
  }

  async _updateFarmerBsuid(farmerId, bsuid) {
    // This would call the database update service
    // Implemented in the data access layer
  }
}

module.exports = WhatsAppMessageSender;
