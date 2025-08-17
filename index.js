const { Client, Databases } = require('node-appwrite');

// إعداد Appwrite
const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);

const DATABASE_ID = 'abs-rtk-db';
const SCHEDULED_REMINDERS_COLLECTION = 'reminder_schedule';
const ORDER_NOTIFICATIONS_COLLECTION = 'order_notifications';

/**
 * Cloud Function لمعالجة التذكيرات المجدولة
 * يتم تشغيلها كل دقيقة عبر Cron Job
 */
module.exports = async ({ req, res, log, error }) => {
    try {
        log('بدء معالجة التذكيرات المجدولة');

        const processedCount = await processScheduledReminders(log, error);

        return res.json({
            success: true,
            message: `تم معالجة ${processedCount} تذكير`,
            processed_count: processedCount
        });

    } catch (err) {
        error(`خطأ في Cloud Function: ${err.message}`);
        return res.json({
            success: false,
            error: err.message
        }, 500);
    }
};

/**
 * معالجة التذكيرات المجدولة
 */
async function processScheduledReminders(log, error) {
    try {
        const now = new Date().toISOString();
        let processedCount = 0;
        
        // جلب التذكيرات المستحقة
        const response = await databases.listDocuments(
            DATABASE_ID,
            SCHEDULED_REMINDERS_COLLECTION,
            [
                `is_active=true`,
                `next_reminder_at<=${now}`
            ]
        );
        
        log(`تم العثور على ${response.documents.length} تذكير مستحق`);
        
        for (const reminder of response.documents) {
            try {
                // التحقق من حالة القراءة
                const isRead = await checkNotificationReadStatus(
                    reminder.order_id, 
                    reminder.designer_id
                );
                
                if (isRead) {
                    // إلغاء جميع التذكيرات المتبقية لهذا الطلب
                    await cancelRemainingReminders(reminder.order_id, reminder.designer_id);
                    log(`تم إلغاء التذكيرات للطلب ${reminder.order_id} - تم قراءة الإشعار`);
                    continue;
                }
                
                // إرسال التذكير
                const currentCount = reminder.reminder_count || 0;
                await sendReminderNotification(
                    reminder.order_id,
                    reminder.designer_id,
                    reminder.notification_id,
                    currentCount + 1,
                    log
                );
                
                // تحديث عداد التذكيرات والتوقيت التالي
                const newCount = currentCount + 1;
                const maxReminders = reminder.max_reminders || 6;
                
                if (newCount >= maxReminders) {
                    // إيقاف التذكيرات
                    await databases.updateDocument(
                        DATABASE_ID,
                        SCHEDULED_REMINDERS_COLLECTION,
                        reminder.$id,
                        {
                            is_active: false,
                            stopped_reason: 'max_reminders_reached',
                            stopped_at: new Date().toISOString()
                        }
                    );
                } else {
                    // جدولة التذكير التالي
                    const nextReminder = new Date(Date.now() + (1 * 60 * 1000)); // 10 دقائق
                    await databases.updateDocument(
                        DATABASE_ID,
                        SCHEDULED_REMINDERS_COLLECTION,
                        reminder.$id,
                        {
                            reminder_count: newCount,
                            last_reminder_sent: new Date().toISOString(),
                            next_reminder_at: nextReminder.toISOString()
                        }
                    );
                }
                
                processedCount++;
                log(`تم إرسال التذكير رقم ${reminder.reminder_number} للطلب: ${reminder.order_id}`);
                
            } catch (err) {
                error(`خطأ في معالجة التذكير ${reminder.$id}: ${err.message}`);
                
                // تحديث حالة التذكير كفاشل
                await databases.updateDocument(
                    DATABASE_ID,
                    SCHEDULED_REMINDERS_COLLECTION,
                    reminder.$id,
                    {
                        is_active: false,
                        stopped_reason: 'error',
                        stopped_at: new Date().toISOString()
                    }
                );
            }
        }
        
        return processedCount;
        
    } catch (err) {
        error(`خطأ في معالجة التذكيرات المجدولة: ${err.message}`);
        throw err;
    }
}

/**
 * التحقق من حالة قراءة الإشعار
 */
async function checkNotificationReadStatus(orderId, designerId) {
    try {
        const response = await databases.listDocuments(
            DATABASE_ID,
            ORDER_NOTIFICATIONS_COLLECTION,
            [
                `order_id=${orderId}`,
                `designer_id=${designerId}`
            ]
        );

        if (response.documents.length > 0) {
            return response.documents[0].is_read || false;
        }
        return false;
    } catch (err) {
        console.error('خطأ في التحقق من حالة القراءة:', err);
        return false;
    }
}

/**
 * إرسال إشعار تذكير
 */
async function sendReminderNotification(orderId, designerId, originalNotificationId, reminderNumber, log) {
    try {
        // إنشاء إشعار التذكير
        const reminderNotification = {
            title: `تذكير ${reminderNumber}: طلب جديد #${orderId.substring(0, 8)}`,
            message: `لم تقم بقراءة إشعار الطلب الجديد بعد. يرجى مراجعة الطلب.`,
            type: 'order_reminder',
            target_audience: `designer:${designerId}`,
            is_in_app: true,
            is_push: true,
            data: JSON.stringify({
                order_id: orderId,
                original_notification_id: originalNotificationId,
                type: 'reminder',
                reminder_number: reminderNumber,
                action: 'view_order'
            }),
            scheduled_at: new Date().toISOString(),
            status: 'sent',
            created_at: new Date().toISOString()
        };

        // حفظ الإشعار في قاعدة البيانات
        await databases.createDocument(
            DATABASE_ID,
            'notifications',
            'unique()',
            reminderNotification
        );

        // إضافة إلى قائمة انتظار الإشعارات للإرسال الفوري
        await databases.createDocument(
            DATABASE_ID,
            'notification_queue',
            'unique()',
            {
                title: reminderNotification.title,
                message: reminderNotification.message,
                target_audience: reminderNotification.target_audience,
                data: reminderNotification.data,
                status: 'pending',
                priority: 'high',
                created_at: new Date().toISOString()
            }
        );

        log(`تم إنشاء إشعار التذكير رقم ${reminderNumber} للطلب: ${orderId}`);

    } catch (err) {
        console.error('خطأ في إرسال إشعار التذكير:', err);
        throw err;
    }
}

/**
 * إلغاء التذكيرات المتبقية
 */
async function cancelRemainingReminders(orderId, designerId) {
    try {
        const response = await databases.listDocuments(
            DATABASE_ID,
            SCHEDULED_REMINDERS_COLLECTION,
            [
                `order_id=${orderId}`,
                `designer_id=${designerId}`,
                `is_active=true`
            ]
        );
        
        for (const reminder of response.documents) {
            await databases.updateDocument(
                DATABASE_ID,
                SCHEDULED_REMINDERS_COLLECTION,
                reminder.$id,
                {
                    is_active: false,
                    stopped_reason: 'notification_read',
                    stopped_at: new Date().toISOString()
                }
            );
        }
    } catch (err) {
        console.error('خطأ في إلغاء التذكيرات المتبقية:', err);
    }
}
