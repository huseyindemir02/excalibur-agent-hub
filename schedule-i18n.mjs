// CLI-only schedule sentences; browser settings use hubPure.t in public/index.html.
export const SCHEDULE_I18N = {
  en: ['Check (hub unread): every {check} min · Heartbeat: every {heartbeat} min', 'updated {date}', 'default', 'Advisory: the hub does not run agents — set your own timer to these values.', 'This hub server does not publish a schedule yet (restart it after updating).'],
  tr: ['Kontrol (hub unread): her {check} dk · Kalp atışı: her {heartbeat} dk', 'güncellendi {date}', 'varsayılan', 'Hub ajanları çalıştırmaz: kendi zamanlayıcını bu değerlere göre kur.', 'Bu hub sunucusu henüz kontrol sıklığını bildirmiyor (güncelledikten sonra yeniden başlatın).'],
  ja: ['確認 (hub unread): {check}分ごと · ハートビート: {heartbeat}分ごと', '更新 {date}', '既定値', '参考値です。Hub はエージェントを実行しません。この値に合わせて自分のタイマーを設定してください。', 'この Hub サーバーは確認間隔をまだ公開していません（更新後に再起動してください）。'],
  ar: ['التحقق (hub unread): كل {check} دقيقة · نبضة الحياة: كل {heartbeat} دقيقة', 'تم التحديث {date}', 'افتراضي', 'هذه قيم إرشادية: لا يشغّل Hub الوكلاء؛ اضبط مؤقتك الخاص وفق هذه القيم.', 'لا ينشر خادم Hub هذا جدول التحقق بعد (أعد تشغيله بعد التحديث).'],
  zh: ['检查 (hub unread)：每 {check} 分钟 · 心跳：每 {heartbeat} 分钟', '更新于 {date}', '默认值', '仅供参考：Hub 不会运行代理，请根据这些值设置自己的定时器。', '此 Hub 服务器尚未发布检查间隔（更新后请重启）。'],
};
export function scheduleText(schedule, lang = 'en') {
  const strings = SCHEDULE_I18N[lang] || SCHEDULE_I18N.en;
  if (!schedule) return { error: strings[4] };
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
  const date = schedule.updatedAt && new Date(schedule.updatedAt);
  const meta = date && Number.isFinite(date.getTime())
    ? fill(strings[1], { date: date.toLocaleString(({ tr: 'tr-TR', en: 'en-GB', ja: 'ja-JP', ar: 'ar', zh: 'zh-CN' })[lang] || 'en-GB') }) : strings[2];
  return { lines: [fill(strings[0], { check: schedule.checkMinutes, heartbeat: schedule.heartbeatMinutes }) + ` (${meta})`, strings[3]] };
}
