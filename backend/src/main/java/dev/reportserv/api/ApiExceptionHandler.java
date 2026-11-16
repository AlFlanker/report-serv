package dev.reportserv.api;

import dev.reportserv.domain.ApiException;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.LinkedHashMap;
import java.util.Map;

@RestControllerAdvice
public class ApiExceptionHandler {
    private static final Logger LOG = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, Object>> known(ApiException error) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("code", error.code()); details.put("message", error.getMessage());
        if (!error.fields().isEmpty()) details.put("fields", error.fields());
        return ResponseEntity.status(error.status()).body(Map.of("error", details));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    public ResponseEntity<Map<String, Object>> invalid(Exception ignored) {
        return known(new ApiException(400, "INVALID_REQUEST", "Некорректный запрос."));
    }

    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> media(Exception ignored) {
        return known(new ApiException(415, "JSON_REQUIRED", "Ожидается JSON."));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Map<String, Object>> method(Exception ignored) {
        return known(new ApiException(405, "METHOD_NOT_ALLOWED", "Метод не поддерживается."));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Map<String, Object>> missing(Exception ignored) {
        return known(new ApiException(404, "NOT_FOUND", "Ресурс не найден."));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> unknown(Exception error, HttpServletResponse response) {
        // Client-disconnected streamed downloads have already sent headers;
        // never append a JSON error document to a partial XLSX response.
        if (response.isCommitted()) return null;
        LOG.warn("API request failed: {}", error.getClass().getSimpleName());
        return known(new ApiException(500, "INTERNAL_ERROR", "Внутренняя ошибка сервиса."));
    }
}
