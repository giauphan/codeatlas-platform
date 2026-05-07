# CodeAtlas Management Dashboard

Dashboard chuyên nghiệp để quản lý người dùng và API Keys cho CodeAtlas MCP Server.

## Kiến trúc Hệ thống

### 1. Luồng Xác thực (Auth Flow)
- **Frontend**: Sử dụng Firebase Auth để quản lý đăng nhập/đăng ký.
- **Trạng thái**: Dashboard sử dụng hook `onAuthStateChanged` để theo dõi trạng thái người dùng. Nếu chưa đăng nhập, người dùng sẽ được chuyển hướng đến trang Auth (Login/Signup).
- **Phân quyền**: Mỗi API Key được gắn với `uid` của người dùng trong Firestore theo schema: `users/{uid}/keys/{keyId}`.

### 2. Xác thực MCP Server qua Firestore
- **Cơ chế**: Thay vì sử dụng biến môi trường tĩnh, MCP Server hiện tại sử dụng `firebase-admin` để truy vấn trực tiếp vào Firestore.
- **Logic**: Khi một request đến (qua SSE hoặc Stdio), server sẽ lấy API Key và thực hiện một `collectionGroup` query trên bộ sưu tập `keys`.
- **Kiểm tra**: Nếu tìm thấy document có field `key` khớp với key được gửi đến, server sẽ cho phép truy cập và đồng thời cập nhật timestamp `lastUsed` cho key đó.
- **Bảo mật**: Điều này cho phép thu hồi key ngay lập tức bằng cách xóa chúng khỏi Dashboard mà không cần khởi động lại MCP Server.

## Hướng dẫn Setup

### Bước 1: Cấu hình Firebase Project
1. Truy cập [Firebase Console](https://console.firebase.google.com/).
2. Tạo dự án mới hoặc chọn dự án hiện có.
3. Bật **Authentication** (Email/Password).
4. Tạo **Cloud Firestore** database.
5. Tạo một Web App và copy object config vào file `dashboard/src/lib/firebase.ts`.

### Bước 2: Thiết lập Firestore Security Rules
Đảm bảo rules cho phép người dùng quản lý key của chính mình:
```javascript
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/keys/{keyId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    // Cho phép MCP Server (Admin) truy vấn qua collectionGroup
    match /{path=**}/keys/{keyId} {
      allow read: if false; // Chỉ Admin SDK mới có quyền truy cập global
    }
  }
}
```

### Bước 3: Cấu hình MCP Server (Admin SDK)
1. Trong Firebase Console, vào **Project Settings > Service Accounts**.
2. Bấm **Generate new private key** để tải file JSON về.
3. Thiết lập biến môi trường `GOOGLE_APPLICATION_CREDENTIALS` trỏ đến đường dẫn file JSON này trên máy chạy MCP Server.

### Bước 4: Chạy Dashboard
```bash
cd dashboard
npm install
npm run dev
```

## Tính năng chính
- **UI Premium Modern Dark Mode**: Giao diện tối hiện đại, sử dụng Framer Motion cho hiệu ứng mượt mà.
- **Key Management**: Tạo, đặt tên và xóa API Keys dễ dàng.
- **Usage Tracking**: Theo dõi thời gian cuối cùng key được sử dụng (Last Used).
- **Responsive**: Hoạt động tốt trên nhiều thiết bị.
