# Allingo Backend

هذا المجلد جاهز للرفع إلى GitHub. ارفع محتوياته بحيث يظهر backend وrender.yaml في الصفحة الرئيسية للمستودع.

## الإعداد على Render

- Root Directory: backend
- Build Command: npm ci && npm run build
- Start Command: npm start
- Health Check Path: /health
- NODE_ENV: production

يحتاج التشغيل الإنتاجي إلى بيانات مشروع Firebase ورابط الخدمة في متغيرات Render. لا ترفع ملفات المفاتيح أو ملف .env إلى GitHub. يمكن استخدام render.yaml للإعداد عبر Blueprint.

الدليل الرسمي: https://render.com/docs/monorepo-support

تعديل المصدر يتم في مشروع Allingo الأصلي؛ هذا المجلد نسخة مخصصة للرفع. لا يتضمن Android أو APK أو بيانات حسابات حقيقية.
