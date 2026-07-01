# Product Requirements Document (PRD)

# Ultra MikroTik Monitoring System

### Version 1.0

### Technology

* Backend : Node.js (LTS)
* Storage : JSON File Database
* Frontend : HTML + CSS + Vanilla JavaScript
* Communication : HTTP Webhook
* Realtime : WebSocket (Socket.IO)
* Deployment : Ubuntu / Windows
* Single Router Monitoring

---

# 1. Project Overview

Membangun sistem monitoring MikroTik yang menerima data webhook setiap **30 detik**.

Sistem harus mampu memberikan monitoring real-time terhadap:

* Status Router
* Status User PPPoE
* History Online Offline User
* History Router
* Traffic RX/TX
* Missing Webhook Detection
* Alert
* Timeline Activity

Target sistem bukan hanya menampilkan data terbaru, tetapi menyimpan seluruh histori sehingga administrator dapat mengetahui:

* Jam berapa user online
* Jam berapa user offline
* Berapa lama user aktif
* Berapa lama user offline
* Router terakhir mengirim data kapan
* Apakah webhook terlambat
* Apakah router mati
* Total uptime user
* Total downtime user

Sistem dibuat khusus untuk **1 Router MikroTik** dengan sekitar **20 user aktif**.

Storage menggunakan **JSON** tanpa database SQL.

---

# 2. Incoming Webhook

MikroTik mengirim GET Request setiap 30 detik.

Contoh

```
GET /webhook/<id>?key=thiskey219Kx
&router=Router
&rx=60019260247
&tx=5583444706
&users=user1;user2;user3;
```

Parameter

| Parameter | Wajib | Keterangan                     |
| --------- | ----- | ------------------------------ |
| key       | Ya    | Secret Key                     |
| router    | Ya    | Nama Router                    |
| rx        | Ya    | RX Byte Interface              |
| tx        | Ya    | TX Byte Interface              |
| users     | Tidak | Daftar user aktif dipisahkan ; |

---

# 3. Authentication

Sistem memiliki konfigurasi

```
config.json
```

```
{
    "secretKey":"thiskey219Kx"
}
```

Flow

Request masuk

↓

Bandingkan key

↓

Jika sama

↓

Process

↓

Jika tidak sama

↓

Ignore Request

↓

Return HTTP 403

Tidak boleh menyimpan data.

Tidak boleh update status.

Tidak boleh membuat log.

---

# 4. System Mode

System memiliki 2 mode.

## RUNNING

* menerima webhook
* update status
* update history
* simpan json

## PAUSE

tetap menerima request

tetapi

tidak menyimpan data

tidak update status

tidak update history

Return

```
System Paused
```

Frontend memiliki tombol

```
RUNNING
```

```
PAUSE
```

Status disimpan pada

```
system.json
```

---

# 5. Router Monitoring

Router dianggap ONLINE apabila webhook diterima.

Field

```
Router Name

Last Seen

RX

TX

Last RX

Last TX

RX Speed

TX Speed

Total Packet

Status

Latency

```

---

Status

Hijau

ONLINE

Merah

OFFLINE

---

# 6. Missing Webhook Detection

Webhook harus datang setiap

30 detik

Jika

```
Last webhook > 5 menit
```

maka

Status Router

MERAH

OFFLINE

Alert muncul

```
Webhook Lost

Last Received

5 Minutes Ago
```

---

Jika webhook datang lagi

Status otomatis

ONLINE

History dibuat.

---

# 7. User Monitoring

User aktif berasal dari parameter

```
users=
```

Misal

```
users=user1;user2;user3;
```

berarti

user1

ONLINE

user2

ONLINE

user3

ONLINE

User lain

OFFLINE

---

Apabila parameter

```
users=
```

kosong

berarti

Semua user

OFFLINE

---

# 8. Offline Detection

Webhook datang setiap

30 detik

Rule

Jika user tidak muncul selama

1 menit

↓

Status berubah

OFFLINE

Misal

12:00:00

userA ada

12:00:30

userA tidak ada

belum offline

12:01:00

tetap tidak ada

↓

OFFLINE

History dibuat.

---

# 9. User History

Setiap perubahan status wajib dicatat.

Contoh

```
08:00 ONLINE

09:12 OFFLINE

09:30 ONLINE

11:15 OFFLINE

```

History tidak boleh hilang.

---

# 10. Session Tracking

Saat user ONLINE

buat session

```
Start Time

```

Saat OFFLINE

isi

```
End Time

Duration

```

Contoh

```
Start

08:00

End

09:15

Duration

1h15m
```

Semua session disimpan.

---

# 11. Statistics

Per user

Total Online Time

Hari ini

Minggu ini

Bulan ini

Jumlah Login

Jumlah Disconnect

Longest Session

Shortest Session

Average Session

Current Session

---

# 12. Router History

Catat

Router Online

Router Offline

Webhook Missing

Webhook Restored

Semua timestamp.

---

# 13. Traffic Monitoring

Setiap webhook

Hitung

RX Delta

TX Delta

Speed

```
Bytes/sec

KB/sec

MB/sec

```

Simpan history.

---

Grafik

1 Menit

5 Menit

15 Menit

30 Menit

1 Jam

24 Jam

---

# 14. Timeline

Halaman timeline

Contoh

```
12:00

Router Online

12:02

UserA Online

12:05

UserB Online

12:12

UserA Offline

12:18

Webhook Lost

12:24

Router Online

```

Urut terbaru.

---

# 15. Dashboard

Widget

Router Status

User Online

User Offline

Current Traffic

RX Speed

TX Speed

Last Webhook

Webhook Delay

System Mode

Total User

Online %

Offline %

---

# 16. User Table

Kolom

Status

Username

Current Session

Total Online

Total Offline

Login Count

Disconnect Count

Last Seen

Last Online

Last Offline

---

Hijau

Online

Merah

Offline

---

# 17. Alerts

Jenis Alert

Webhook Missing

Router Offline

Router Restored

User Offline

User Online

Secret Key Invalid

System Pause

System Running

---

Semua alert memiliki timestamp.

---

# 18. JSON Storage Structure

```
/storage

config.json

system.json

router.json

users.json

sessions.json

traffic.json

history.json

alerts.json

logs.json
```

---

# 19. History.json

```
[
{
"time":"",
"type":"user_online",
"user":"user1"
},
{
"time":"",
"type":"router_offline"
}
]
```

---

# 20. Users.json

```
{
"user1":{
"status":"online",
"lastSeen":"",
"lastOnline":"",
"lastOffline":"",
"totalOnline":0,
"loginCount":0,
"disconnectCount":0
}
}
```

---

# 21. Sessions.json

```
[
{
"user":"user1",
"start":"",
"end":"",
"duration":1234
}
]
```

---

# 22. Router.json

```
{
"status":"online",
"lastSeen":"",
"rx":0,
"tx":0,
"rxSpeed":0,
"txSpeed":0
}
```

---

# 23. Traffic.json

```
[
{
"time":"",
"rx":123,
"tx":456,
"rxSpeed":100,
"txSpeed":200
}
]
```

---

# 24. Auto Cleanup

History

Simpan

365 Hari

Traffic

Per 30 detik

Simpan

30 Hari

Logs

90 Hari

Session

Tidak pernah dihapus.

---

# 25. Web Dashboard

Halaman

Dashboard

Users

Router

Timeline

Traffic

Alerts

Settings

Logs

---

# 26. Settings

Secret Key

Webhook Interval

Offline Timeout User

Offline Timeout Router

History Retention

Traffic Retention

System Mode

Auto Save

Auto Backup

---

# 27. Logging

Semua event dicatat.

Contoh

```
Webhook Received

Webhook Ignored

Secret Invalid

Router Offline

Router Online

User Online

User Offline

Pause

Running
```

---

# 28. Performance Requirements

Target:

* Maksimum 20 user aktif.
* Interval webhook 30 detik.
* Semua proses selesai dalam <100 ms per request.
* Penulisan file JSON dilakukan secara atomic (write ke file sementara lalu rename) untuk mencegah korupsi.
* Debounce penulisan agar tidak melakukan write berlebihan saat data tidak berubah.

---

# 29. Data Integrity Rules

* Username dibandingkan secara case-sensitive.
* Username unik.
* User yang tidak muncul selama ≥60 detik dianggap OFFLINE.
* Router dianggap OFFLINE bila tidak ada webhook selama ≥300 detik.
* Event hanya dicatat ketika status benar-benar berubah (hindari duplikasi history).
* Validasi nilai `rx` dan `tx` harus berupa integer dan tidak boleh negatif.
* Jika nilai counter RX/TX lebih kecil dari sebelumnya (counter reset/reboot), sistem harus mendeteksi reset dan memulai perhitungan delta baru tanpa menghasilkan nilai negatif.

---

# 30. Backup & Recovery

* Backup otomatis seluruh folder `/storage` setiap hari ke folder `/backup`.
* Simpan minimal 30 backup harian.
* Saat aplikasi startup, validasi seluruh file JSON.
* Jika file korup, gunakan backup terbaru dan catat alert `Storage Recovered`.

---

# 31. Health Monitoring

Tambahkan endpoint:

* `GET /health` → status aplikasi.
* `GET /metrics` → statistik internal (uptime aplikasi, jumlah webhook diterima, webhook ditolak, total event, penggunaan memori, penggunaan CPU).
* `GET /status` → ringkasan router, jumlah user online/offline, status sistem.

---

# 32. Future Ready

Arsitektur harus modular sehingga di masa depan mudah ditambahkan:

* Multi-router.
* Telegram Notification.
* WhatsApp Notification.
* Email Alert.
* Discord Webhook.
* Export CSV/PDF.
* REST API.
* Authentication/Login.
* Dark Mode.
* Progressive Web App (PWA).

---

# Final Goal

Sistem ini harus memberikan visibilitas penuh terhadap kondisi jaringan hanya dari webhook MikroTik, dengan kemampuan audit lengkap, histori aktivitas, deteksi kehilangan webhook, pelacakan sesi setiap pengguna, monitoring trafik real-time, alert otomatis, dashboard interaktif, serta penyimpanan berbasis JSON yang ringan namun andal untuk penggunaan jangka panjang.

PRD ini sudah cukup rinci untuk digunakan sebagai spesifikasi implementasi oleh AI code builder sehingga dapat membangun sistem monitoring end-to-end tanpa perlu banyak asumsi tambahan.
