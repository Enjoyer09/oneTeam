import { Injectable, Logger } from '@nestjs/common';
import { StoreTask, TelegramNotificationPayload, PushNotificationPayload } from '@oneteam/types';
import { db } from '@oneteam/database';

@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);

  // In-memory queue for inspection and testing
  public dispatchedTelegramMessages: TelegramNotificationPayload[] = [];
  public dispatchedPushNotifications: PushNotificationPayload[] = [];

  /**
   * Dispatches multi-channel notifications when a task transitions to PUBLISHED.
   */
  async dispatchTaskPublished(task: StoreTask): Promise<{
    telegram: boolean;
    pushNotification: boolean;
  }> {
    const store = db.getStore(task.storeId);
    const storeName = store ? store.name : 'Tərəfdaş Mağaza';
    const storeCode = store ? store.storeCode : 'N/A';

    this.logger.log(
      `📢 [MULTI-CHANNEL DISPATCH] Task ${task.id} PUBLISHED for store ${storeCode} (${storeName})`,
    );

    // 1. Prepare Telegram Message with Interactive Inline Buttons
    const telegramPayload: TelegramNotificationPayload = {
      chatId: task.assignedUserId || '998877665',
      text:
        `📌 *YENİ PLANOGRAM AUDİT TAPŞIRIĞI!*\n\n` +
        `🏪 *Mağaza:* ${storeName} (\`${storeCode}\`)\n` +
        `⚡ *Prioritet:* 🟠 Yüksək\n` +
        `⏰ *Son Tarix:* ${new Date(task.deadline).toLocaleDateString('az-AZ', {
          timeZone: 'Asia/Baku',
        })}\n\n` +
        `📝 *Təlimat:* Ön vitrin soyuducusunda Coca-Cola Classic, Zero Sugar və Fanta düzülüşünü yoxlayın.\n\n` +
        `Tapşırığı icraya götürmək üçün aşağıdakı düyməni sıxın:`,
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: '✅ Qəbul Et (Acknowledge)',
              callback_data: `ack_task_${task.id}`,
            },
          ],
          [
            {
              text: '📱 oneTeam Tətbiqində Aç',
              url: `oneteam://tasks/${task.id}`,
            },
          ],
        ],
      },
    };

    // 2. Prepare Mobile Client Push Notification (APNs / FCM)
    const pushPayload: PushNotificationPayload = {
      to: `device_token_${task.assignedUserId || 'merchandiser_003'}`,
      title: '📌 Yeni Rəf Tapşırığı Təyin Edildi',
      body: `${storeName}: Coca-Cola vitrin yoxlaması təsdiq gözləyir.`,
      badge: 1,
      sound: 'default',
      data: {
        taskId: task.id,
        storeId: task.storeId,
        type: 'TASK_PUBLISHED',
        deepLink: `oneteam://tasks/${task.id}`,
      },
    };

    // Record dispatches
    this.dispatchedTelegramMessages.push(telegramPayload);
    this.dispatchedPushNotifications.push(pushPayload);

    // Record in Audit Log
    db.logAuditEvent({
      entityType: 'notification',
      entityId: task.id,
      action: 'MULTI_CHANNEL_DISPATCH',
      toState: 'PUBLISHED',
      payload: {
        telegramChatId: telegramPayload.chatId,
        pushRecipient: pushPayload.to,
      },
    });

    this.logger.log(
      `✅ [DISPATCH COMPLETE] Telegram message and APNs push payload queued for Task ${task.id}`,
    );

    return {
      telegram: true,
      pushNotification: true,
    };
  }
}
