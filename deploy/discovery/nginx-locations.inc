# Included inside the existing HTTPS server for 39.106.128.14.
location ^~ /v1/instances/ {
    client_max_body_size 16k;
    proxy_pass http://127.0.0.1:18090;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_connect_timeout 3s;
    proxy_read_timeout 10s;
    proxy_send_timeout 10s;
    add_header Cache-Control "no-store" always;
}

location = /rightdata-discovery/healthz {
    proxy_pass http://127.0.0.1:18090/healthz;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_connect_timeout 3s;
    proxy_read_timeout 5s;
    add_header Cache-Control "no-store" always;
}
