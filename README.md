# Allingo Backend

خادم تطبيق Allingo. يحتوي المستودع على backend وrender.yaml لإعداد الخدمة على Render.

## الإعداد على Render

- Root Directory: backend
- Build Command: npm ci --include=dev && npm run build
- Start Command: npm start
- Health Check Path: /health
- NODE_ENV: production

يحتاج التشغيل الإنتاجي إلى FIREBASE_PROJECT_ID وFIREBASE_CLIENT_EMAIL وFIREBASE_PRIVATE_KEY وTRUST_PROXY=1 في متغيرات Render. يقرأ الخادم رابط الخدمة تلقائيًا من RENDER_EXTERNAL_URL؛ لا يلزم إدخال PUBLIC_BASE_URL إلا لتحديد نطاق HTTPS مخصص. احذف FIREBASE_AUTH_EMULATOR_HOST وFIRESTORE_EMULATOR_HOST إن وُجدا. لا ترفع ملفات المفاتيح أو ملف .env إلى GitHub. يمكن استخدام render.yaml للإعداد عبر Blueprint.

الدليل الرسمي: https://render.com/docs/monorepo-support

تعديل المصدر يتم في مشروع Allingo الأصلي؛ هذا المجلد نسخة مخصصة للرفع. لا يتضمن Android أو APK أو بيانات حسابات حقيقية.
